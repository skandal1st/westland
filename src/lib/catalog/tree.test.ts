import { it, expect } from 'vitest'
import { categoryAncestry, categoryForest } from './tree'
import { matchesGiftCondition } from '@/lib/promotions/gifts'
import { promotionScopeMatches } from '@/lib/pricing/promotions'
it('category rules include arbitrary descendants without matching siblings',()=>{
  const ancestry=categoryAncestry([{id:'root',parentId:null},{id:'brand',parentId:'root'},{id:'line',parentId:'brand'},{id:'leaf',parentId:'line'},{id:'sibling',parentId:null}])
  const item={productId:'p',categoryId:'leaf',categoryAncestorIds:ancestry('leaf'),brandId:null,packaging:''}
  expect(matchesGiftCondition({categoryId:'root'},item)).toBe(true)
  expect(matchesGiftCondition({categoryId:'brand'},item)).toBe(true)
  expect(matchesGiftCondition({categoryId:'sibling'},item)).toBeFalsy()
  expect(promotionScopeMatches({categoryIds:['root']},{variantId:'v',...item})).toBe(true)
  expect(promotionScopeMatches({categoryIds:['sibling']},{variantId:'v',...item})).toBe(false)
})
it('excludes hidden ancestors and malformed cycles',()=>{
  const row=(id:string,parentId:string|null,hidden=false)=>({id,parentId,hidden,name:id,slug:id,mergedIntoId:null})
  expect(categoryForest([row('hidden',null,true),row('child','hidden'),row('a','b'),row('b','a')],new Map(),true)).toEqual([])
})
