import { readFileSync } from 'node:fs'
import { discoverOData, ODataDiscoveryError, type ODataReadConfig } from '../src/lib/integrations/onec/odata-discovery'

async function main() {
  const configPath = process.argv[2]
  if (!configPath || process.argv.length !== 3) throw new ODataDiscoveryError('usage_check_onec_odata_private_config_json')
  let config: ODataReadConfig
  try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch { throw new ODataDiscoveryError('odata_config_unreadable') }
  if (!config || typeof config !== 'object') throw new ODataDiscoveryError('odata_config_invalid')
  const result = await discoverOData(config)
  console.log(JSON.stringify(result, null, 2))
  if (!result.readyForMapping) process.exitCode = 1
}
main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof ODataDiscoveryError ? error.code : 'odata_check_failed' }))
  process.exitCode = 1
})
