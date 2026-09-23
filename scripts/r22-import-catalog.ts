/** Explicitly reviewed R22 test import; never targets a production database. */
import fs from 'node:fs';
import {prisma as db} from '../src/lib/db';
import {publishGeneration} from '../src/lib/integrations/onec/ledger';
import {readGenerationFile} from '../src/lib/integrations/onec/storage';
import {saveSourceMapping} from '../src/lib/integrations/mappings';
import {enqueueSourceSync} from '../src/lib/integrations/sync-queue';
import {runWorkerTick} from '../src/lib/integrations/worker';
import {assertLicenseActive,reloadLicenseState} from '../src/lib/license';

async function main(){
 const url=new URL(process.env.DATABASE_URL||'');
 if(process.env.R22_ACCEPTANCE!=='1'||url.hostname!=='postgres-r22'||url.pathname!=='/axima_r22_acceptance')throw Error('isolated_database_required');
 const mode=process.argv[2];if(!['full','delta'].includes(mode))throw Error('usage: full|delta');
 const source=await db.integrationConnection.findUniqueOrThrow({where:{id:process.env.ONEC_EXCHANGE_CONNECTION_ID}});
 const store=await db.store.findUniqueOrThrow({where:{id:source.storeId}});
 if(store.slug!=='r22-acceptance'||source.environment!=='TEST'||source.provider!=='ONE_C'||!source.enabled||source.sourceState!=='ACTIVE')throw Error('isolated_source_required');
 if(await db.order.count())throw Error('unexpected_orders');
 assertLicenseActive(reloadLicenseState());
 const review=JSON.parse(fs.readFileSync('/app/r22-config/catalog-selection.json','utf8'));
 const catalog=review.find((r:any)=>r.name==='import0_1.xml'&&r.meta.mode==='full');
 const offers=review.find((r:any)=>r.name==='offers0_1.xml'&&r.meta.mode==='full');
 const delta=review.find((r:any)=>r.name==='offers0_1.xml'&&r.meta.mode==='delta');
 if(!catalog||!offers||!delta||offers.catalogIdentity!==catalog.meta.identity||delta.catalogIdentity!==catalog.meta.identity||catalog.root['ДатаФормирования']!==offers.root['ДатаФормирования']||catalog.root['ДатаФормирования']!==delta.root['ДатаФормирования']||review.some((r:any)=>r.dupes||r.missing))throw Error('review_not_consistent');
 // The delta repeats catalog tombstones without deletion flags: retain its matching catalog context.
 const selected=mode==='full'?[catalog,offers]:[catalog,delta];
 for(const r of selected){const session=await db.onecExchangeSession.findUniqueOrThrow({where:{id:r.sessionId}});if(session.connectionId!==source.id||session.sourceRevision!==source.exchangeRevision)throw Error('session_changed');const file=(session.files as any[]).find(f=>f.name===r.name);if(!file||file.sha256!==r.sha256||file.size!==r.size)throw Error('reviewed_file_changed');await readGenerationFile(source.id,{...file,sessionId:session.id});}
 if(mode==='delta'&&!await db.syncRun.count({where:{connectionId:source.id,status:'SUCCEEDED'}}))throw Error('full_import_required');
 const actor=await db.user.upsert({where:{storeId_email:{storeId:store.id,email:'r22-acceptance@localhost'}},create:{storeId:store.id,email:'r22-acceptance@localhost',name:'R22 isolated import operator',role:'STAFF',status:'SUSPENDED',passwordHash:'!disabled'},update:{},select:{id:true,email:true}});
 for(const d of offers.dictionaries){
  const code='onec-'+d['Ид'];let target;
  if(d.type==='ТипЦены'){if(d['Валюта']!=='RUB')throw Error('unexpected_currency');target=await db.priceBook.upsert({where:{storeId_code:{storeId:store.id,code}},create:{storeId:store.id,code,name:d['Наименование'],currency:d['Валюта']},update:{}})}
  else if(d.type==='Склад')target=await db.inventoryLocation.upsert({where:{storeId_code:{storeId:store.id,code}},create:{storeId:store.id,code,name:d['Наименование']},update:{}});
  else throw Error('unexpected_dictionary');
  await saveSourceMapping(store.id,source.id,{entityType:d.type==='ТипЦены'?'priceType':'location',externalId:d['Ид'],entityId:target.id},actor);
 }
 const generation=await publishGeneration(store.id,source.id,selected.map((r:any)=>r.sessionId),actor);
 const queued=await enqueueSourceSync(source,generation.id);
 console.log(JSON.stringify({event:'queued',mode,generationId:generation.id,runId:queued.runId}));
 for(let i=0;i<3;i++){
  const result=await runWorkerTick({storeId:store.id});
  const run=await db.syncRun.findUniqueOrThrow({where:{id:queued.runId}});
  console.log(JSON.stringify({event:'tick',...result,status:run.status,report:run.stats}));
  if(!['PENDING','RUNNING'].includes(run.status)){if(run.status!=='SUCCEEDED')throw Error('import_not_successful');break}
 }
 const run=await db.syncRun.findUniqueOrThrow({where:{id:queued.runId}});
 if(run.status!=='SUCCEEDED')throw Error('import_incomplete');
 const counts={products:await db.product.count(),variants:await db.productVariant.count(),prices:await db.priceEntry.count(),stocks:await db.stock.count(),orders:await db.order.count()};
 console.log(JSON.stringify({event:'completed',mode,counts}));
}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1});
