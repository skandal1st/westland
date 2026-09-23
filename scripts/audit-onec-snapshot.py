"""Offline R16 reconciliation. Reads an authorized local snapshot; never connects to a server.
Usage: python scripts/audit-onec-snapshot.py SOURCE_DIR OUTPUT_DIR
The database.json input is the read-only, product-only selection described in R16.
"""
import collections
import copy
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def audit(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output:
        raise ValueError("Keep derived evidence separate from original files")
    output.mkdir(parents=True, exist_ok=True)
    contract = json.loads((Path(__file__).resolve().parents[1] / "tests/fixtures/onec/r05-contract.json").read_text(encoding="utf-8"))
    roots, hashes = {}, []
    for item in contract["sourceFiles"]:
        data = (source / item["name"]).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != item["sha256"] or len(data) != item["bytes"]:
            raise ValueError("Snapshot differs from R05 contract: " + item["name"])
        root = ET.fromstring(data)
        # Preserve unprefixed source element names when writing selected fixtures.
        if root.tag.startswith("{"):
            ET.register_namespace("", root.tag[1:].split("}")[0])
        roots[item["name"]] = root
        hashes.append({"name": item["name"], "bytes": len(data), "sha256": digest})
    db = json.loads((source / "database.json").read_text(encoding="utf-8"))
    local = lambda tag: tag.rsplit("}", 1)[-1]
    def txt(node, key):
        child = next((c for c in node if local(c.tag) == key), None)
        return (child.text or "").strip() if child is not None else ""
    def descendants(node, name):
        return [e for e in node.iter() if local(e.tag) == name]
    catalog, offers = roots["import0_1.xml"], roots["offers0_1.xml"]
    products, by_sku = [], collections.defaultdict(list)
    for node in descendants(catalog, "Товар"):
        reqs = {txt(r, "Наименование"): txt(r, "Значение") for r in descendants(node, "ЗначениеРеквизита")}
        row = {"externalId": txt(node, "Ид"), "sku": txt(node, "Артикул") or txt(node, "Штрихкод") or reqs.get("Код", ""), "name": txt(node, "Наименование"), "code": reqs.get("Код"), "itemType": reqs.get("ВидНоменклатуры"), "requirements": reqs}
        products.append(row)
        by_sku[row["sku"]].append(row)
    source_by_id = {p["externalId"]: p for p in products}
    refs = {r["externalId"]: r for r in db["references"]}
    db_products = {p["id"]: p for p in db["products"]}
    db_variant = {v["id"]: v for p in db["products"] for v in p["variants"]}
    offer_rows, warehouses, price_types = {}, set(), set()
    for node in descendants(offers, "Предложение"):
        prices = [{"type": txt(p, "ИдТипаЦены"), "currency": txt(p, "Валюта"), "amount": txt(p, "ЦенаЗаЕдиницу")} for p in descendants(node, "Цена")]
        stocks = {e.attrib["ИдСклада"]: e.attrib.get("КоличествоНаСкладе") for e in node.iter() if "ИдСклада" in e.attrib}
        warehouses.update(stocks)
        price_types.update(p["type"] for p in prices)
        offer_rows[txt(node, "Ид")] = {"prices": prices, "stocks": stocks, "total": txt(node, "Количество")}
    conflicts = [{"sku": sku, "members": [{**p, "mapped": p["externalId"] in refs, "offer": offer_rows.get(p["externalId"])} for p in rows]} for sku, rows in sorted(by_sku.items()) if len(rows) > 1]
    missing = [{**p, "reason": "SKU_CONFLICT" if len(by_sku[p["sku"]]) > 1 else "UNEXPLAINED"} for p in products if p["externalId"] not in refs]
    changed, ambiguous = [], []
    variant_external = {}
    for external_id, ref in refs.items():
        product = db_products.get(ref["entityId"])
        if not product or len(product["variants"]) != 1 or not product["variants"][0]["isDefault"]:
            ambiguous.append(external_id)
            continue
        variant = product["variants"][0]
        variant_external[variant["id"]] = external_id
        if external_id in source_by_id and variant["sku"] != source_by_id[external_id]["sku"]:
            changed.append({"externalId": external_id, "databaseSku": variant["sku"], "sourceSku": source_by_id[external_id]["sku"]})
    error_ids = collections.Counter()
    for err in db["errors"]:
        context = err.get("context") or {}
        external_id = context.get("externalId") if isinstance(context, dict) else None
        if external_id:
            error_ids[external_id] += 1
    negative_stocks = [{"externalId": eid, "warehouseExternalId": wh, "quantity": qty} for eid, offer in offer_rows.items() for wh, qty in offer["stocks"].items() if float(qty.replace(",", ".")) < 0]
    controls = [{**c, "rawProduct": source_by_id[c["externalId"]], "rawOffer": offer_rows[c["externalId"]]} for c in contract["controls"]]
    inventory = json.loads((Path(__file__).resolve().parents[1] / "docs/audits/evidence/remediation/r05-source-inventory.json").read_text(encoding="utf-8"))
    location_external = {r["entityId"]: r["externalId"] for r in inventory["references"] if r["entityType"] == "location"}
    price_diffs, stock_diffs = [], []
    from decimal import Decimal
    price_type = contract["channels"][0]["priceTypeExternalId"]
    for row in db["prices"]:
        eid = variant_external.get(row["variantId"])
        expected = [p for p in offer_rows.get(eid, {}).get("prices", []) if p["type"] == price_type]
        if len(expected) != 1 or Decimal(expected[0]["amount"]) != Decimal(row["amount"]):
            price_diffs.append({"externalId": eid, "database": row, "source": expected})
    for row in db["stocks"]:
        eid = variant_external.get(row["variantId"])
        scope = location_external.get(row["locationId"])
        expected = offer_rows.get(eid, {}).get("stocks", {}).get(scope)
        if expected is None or Decimal(expected) != Decimal(row["available"]):
            stock_diffs.append({"externalId": eid, "database": row, "source": expected})
    positive_mapped = {eid for eid in refs if any(p["type"] == price_type and Decimal(p["amount"]) > 0 for p in offer_rows.get(eid, {}).get("prices", []))}
    priced_ids = {variant_external.get(p["variantId"]) for p in db["prices"]}
    summary = {"files": hashes, "observedAt": db["observedAt"], "sourceProducts": len(products), "uniqueExternalIds": len(source_by_id), "uniqueSkus": len(by_sku), "sourceOffers": len(offer_rows), "negativeStockTuples": len(negative_stocks), "negativeStockProducts": len({r["externalId"] for r in negative_stocks}), "conflictsWithDifferentNames": sum(len({m["name"] for m in c["members"]}) > 1 for c in conflicts), "missingWithPositiveStock": sum(any(float(qty.replace(",", ".")) > 0 for qty in offer_rows.get(p["externalId"], {}).get("stocks", {}).values()) for p in missing), "databaseProducts": len(db_products), "databaseVariants": len(db_variant), "references": len(refs), "missingReferences": len(missing), "unexplainedMissing": sum(p["reason"] == "UNEXPLAINED" for p in missing), "extraReferences": sorted(set(refs) - set(source_by_id)), "skuConflictGroups": len(conflicts), "skuConflictMembers": sum(len(c["members"]) for c in conflicts), "skuConflictExcess": sum(len(c["members"]) - 1 for c in conflicts), "skuRenames": len(changed), "ambiguousVariants": ambiguous, "catalogErrors": len(db["errors"]), "errorExternalIds": len(error_ids), "missingWithoutError": sorted({p["externalId"] for p in missing} - set(error_ids)), "errorRepeatCounts": dict(collections.Counter(error_ids.values())), "priceDifferences": len(price_diffs), "stockDifferences": len(stock_diffs), "positiveMappedPrices": len(positive_mapped), "missingPositivePrices": sorted(positive_mapped-priced_ids), "unexpectedPrices": sorted(priced_ids-positive_mapped), "warehouses": sorted(warehouses), "priceTypes": sorted(price_types), "metadata": {name: {"root": root.attrib, "packetKind": next(local(e.tag) for e in root.iter() if local(e.tag) in ["Каталог", "ПакетПредложений", "ИзмененияПакетаПредложений"]), "packet": next(e.attrib for e in root.iter() if local(e.tag) in ["Каталог", "ПакетПредложений", "ИзмененияПакетаПредложений"])} for name, root in roots.items()}}
    correction_candidates = {"status": "REVIEW_REQUIRED_NOT_APPLIED", "sourceFiles": hashes, "databaseSha256": hashlib.sha256((source / "database.json").read_bytes()).hexdigest(), "rule": "Do not merge products or silently drop conflicting external IDs. Candidate internal codes are suggestions, not approved SKU assignments.", "rows": [{"externalId": p["externalId"], "currentSourceSku": p["sku"], "candidateInternalCode": p["code"], "candidateAlreadyUsedAsSku": p["code"] in by_sku, "existingOwners": [{"externalId": m["externalId"], "productId": refs[m["externalId"]]["entityId"]} for m in by_sku[p["sku"]] if m["externalId"] in refs], "action": "REQUIRES_IDENTITY_RULE_DECISION"} for p in missing]}
    (output/"correction-candidates.json").write_text(json.dumps(correction_candidates, ensure_ascii=False, indent=2), encoding="utf-8")
    details = {"negativeStocks": negative_stocks, "conflicts": conflicts, "missing": missing, "skuRenames": changed, "priceDifferences": price_diffs, "stockDifferences": stock_diffs, "controls": controls, "errorExternalIds": dict(error_ids)}
    for name, data in [("summary.json", summary), ("details.json", details)]:
        (output/name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    # Selected source nodes, not synthetic products. Metadata and other XML sections remain unchanged.
    control_ids = {c["externalId"] for c in contract["controls"]}
    mapped_ids = set(refs)
    for selection, keep in [("controls", control_ids), ("mapped-diagnostic", mapped_ids)]:
        folder = output/selection
        folder.mkdir(exist_ok=True)
        for filename, root in roots.items():
            selected = copy.deepcopy(root)
            for parent in selected.iter():
                for child in list(parent):
                    if local(child.tag) in ["Товар", "Предложение"] and txt(child, "Ид") not in keep:
                        parent.remove(child)
            ET.ElementTree(selected).write(folder/filename, encoding="utf-8", xml_declaration=True)
    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: audit-onec-snapshot.py SOURCE_DIR OUTPUT_DIR")
    audit(sys.argv[1], sys.argv[2])
