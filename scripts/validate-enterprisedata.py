"""Validate emitted pilot headers/orders against official 1C type definitions.
Usage: python scripts/validate-enterprisedata.py <EnterpriseData1_20.xsd> <ExchangeMessage.xsd> <packet.xml>...
Use --directory-only for the supported catalog objects.
Use --orders-only before paths for newer headers; envelope validation remains the adapter responsibility.
The originals are never modified. Only global element declarations are added in memory.
Requires lxml. No network, database, or 1C calls.
"""
import hashlib
import json
import sys
from pathlib import Path
from lxml import etree as E

XS = 'http://www.w3.org/2001/XMLSchema'
MSG = 'http://www.1c.ru/SSL/Exchange/Message'
ED = 'http://v8.1c.ru/edi/edi_stnd/EnterpriseData/1.20'

class Resolver(E.Resolver):
    def __init__(self, message_bytes):
        self.message_bytes = message_bytes
    def resolve(self, url, public_id, context):
        if url == 'urn:offline:message-schema':
            return self.resolve_string(self.message_bytes, context)
        raise ValueError('unexpected schema dependency')

def schema_parser():
    return E.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)

def main():
    args = sys.argv[1:]
    directory_only = bool(args and args[0] == '--directory-only')
    orders_only = bool(args and args[0] == '--orders-only') or directory_only
    if orders_only:
        args = args[1:]
    ed_path, msg_path, *packets = [Path(p) for p in args]
    if not packets:
        raise ValueError('provide at least one packet')
    msg_bytes = msg_path.read_bytes()
    parser = schema_parser(); parser.resolvers.add(Resolver(msg_bytes))
    ed = E.fromstring(ed_path.read_bytes(), parser)
    if ed.get('targetNamespace') != ED:
        raise ValueError('EnterpriseData 1.20 required')
    for imp in ed.findall('{%s}import' % XS):
        if imp.get('namespace') != MSG:
            raise ValueError('unexpected schema import')
        imp.set('schemaLocation', 'urn:offline:message-schema')
    supported = ['Справочник.Номенклатура', 'Справочник.Контрагенты', 'Справочник.НоменклатураГруппа', 'Справочник.КонтрагентыГруппа'] if directory_only else ['Документ.ЗаказКлиента']
    for name in supported:
        E.SubElement(ed, '{%s}element' % XS, name=name, type='tns:' + name)
    order_schema = E.XMLSchema(ed)
    msg = E.fromstring(msg_bytes, schema_parser())
    E.SubElement(msg, '{%s}element' % XS, name='Header', type='tns:Header')
    header_schema = E.XMLSchema(msg)
    results = []
    for path in packets:
        data = path.read_bytes()
        if len(data) > 16 * 1024 * 1024:
            raise ValueError('packet too large')
        tree = E.fromstring(data, schema_parser())
        if tree.getroottree().docinfo.doctype:
            raise ValueError('DTD forbidden')
        if tree.tag != 'Message':
            raise ValueError('Message required')
        header = tree.find('{%s}Header' % MSG)
        if header is None:
            raise ValueError('Header required')
        if not orders_only:
            header_schema.assertValid(header)
        body = tree.find('{%s}Body' % ED)
        allowed = [header] + ([body] if body is not None else [])
        if list(tree) != allowed:
            raise ValueError('unexpected envelope nodes')
        count = 0
        if body is not None:
            for obj in body:
                if obj.tag not in ['{%s}%s' % (ED, name) for name in supported]:
                    raise ValueError('unsupported pilot object')
                order_schema.assertValid(obj)
                count += 1
        results.append({'file': path.name, 'sha256': hashlib.sha256(data).hexdigest(), ('directoryObjectsValidated' if directory_only else 'ordersValidated'): count})
    print(json.dumps({'valid': True, 'headerValidated': not orders_only, 'schemaSha256': hashlib.sha256(ed_path.read_bytes()).hexdigest(), 'messageSchemaSha256': hashlib.sha256(msg_bytes).hexdigest(), 'packets': results}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
