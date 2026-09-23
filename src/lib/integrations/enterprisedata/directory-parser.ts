import { z } from 'zod';
import { child, scalar, parseXml, ED_NS, fail, type XmlNode } from './message';
export const DIRECTORY_TYPES = { 'Справочник.Номенклатура': 'product', 'Справочник.Контрагенты': 'counterparty', 'Справочник.НоменклатураГруппа': 'productGroup', 'Справочник.КонтрагентыГруппа': 'counterpartyGroup' } as const;
const guid = z.string().uuid().transform(v => v.toLowerCase()).refine(v => v !== '00000000-0000-0000-0000-000000000000');
const bounded = z.string().max(2000);
export const DirectoryData = z.object({
    kind: z.enum(['product', 'counterparty', 'productGroup', 'counterpartyGroup', 'partner']), externalId: guid, name: bounded.min(1),
    counterpartyIds: z.array(guid).max(500).optional(), sourceExportedAt: z.string().datetime().optional(),
    fullName: bounded.optional(), code: bounded.optional(), article: bounded.optional(), inn: z.string().max(12).optional(), kpp: z.string().max(9).optional(),
    personType: bounded.optional(), entrepreneur: z.boolean().optional(), parentId: guid.optional(), archived: z.boolean().optional(),
    description: z.string().max(65536).optional(), productType: bounded.optional(),
    baseUnit: z.object({ code: bounded, name: bounded }).optional(), vat: z.object({ rate: z.string().max(40).optional(), exempt: z.boolean().optional() }).optional(),
    contacts: z.array(z.object({ kind: bounded, label: bounded, value: z.string().max(65536), display: z.string().max(65536) })).max(100).optional(),
});
export type DirectoryDataType = z.infer<typeof DirectoryData>;
function optional(n: XmlNode, key: string) { return child(n, key) ? scalar(n, key) : undefined; }
function flag(n: XmlNode, key: string) { const v = optional(n, key); if (v === undefined)
    return undefined; if (!['true', 'false', '1', '0'].includes(v))
    return fail('ed_directory_boolean'); return v === 'true' || v === '1'; }
function contactDisplay(value: string) {
    if (!value.trim().startsWith('<'))
        return value;
    try {
        const n = parseXml(Buffer.from(value));
        return n.attributes?.['|Представление'] ?? optional(n, 'Представление') ?? value;
    }
    catch {
        return value;
    }
}
export function parseDirectoryObject(node: XmlNode): {
    data: DirectoryDataType;
    raw: XmlNode;
} {
    if (node.ns !== ED_NS || !Object.prototype.hasOwnProperty.call(DIRECTORY_TYPES, node.name))
        return fail('ed_directory_type_unsupported');
    const kind = DIRECTORY_TYPES[node.name as keyof typeof DIRECTORY_TYPES], keys = child(node, 'КлючевыеСвойства') ?? fail('ed_directory_keys_required');
    const common = child(node, 'ОбщиеСвойстваОбъектовФормата'), state = common && optional(common, 'СостояниеОбъекта');
    const group = child(keys, 'Группа'), unit = child(node, 'ЕдиницаИзмерения'), classifier = unit && child(unit, 'ДанныеКлассификатора'), vat = child(node, 'СтавкаНДС'), contacts = child(node, 'КонтактнаяИнформация');
    const value = { kind, externalId: scalar(keys, 'Ссылка'), name: scalar(keys, 'Наименование'), fullName: optional(keys, 'НаименованиеПолное'), code: optional(keys, 'КодВПрограмме'), article: optional(keys, 'Артикул'),
        inn: optional(keys, 'ИНН'), kpp: optional(keys, 'КПП'), personType: optional(keys, 'ЮридическоеФизическоеЛицо'), entrepreneur: flag(keys, 'ИндивидуальныйПредприниматель'),
        parentId: group && optional(group, 'Ссылка'), archived: state ? state === 'Устаревший' : undefined, description: optional(node, 'Описание'), productType: optional(node, 'ТипНоменклатуры'),
        baseUnit: classifier ? { code: scalar(classifier, 'Код'), name: scalar(classifier, 'Наименование') } : undefined,
        vat: vat ? { rate: optional(vat, 'Ставка'), exempt: flag(vat, 'НеОблагается') } : undefined,
        contacts: contacts?.children.map(row => { if (row.ns !== ED_NS || row.name !== 'Строка')
            return fail('ed_directory_contact_invalid'); const value = scalar(row, 'ЗначенияПолей'); return { kind: scalar(row, 'ВидКонтактнойИнформации'), label: optional(row, 'НаименованиеКонтактнойИнформации') ?? '', value, display: contactDisplay(value) }; }) };
    return { data: DirectoryData.parse(value), raw: node };
}
