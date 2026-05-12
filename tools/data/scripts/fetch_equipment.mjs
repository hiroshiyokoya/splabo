#!/usr/bin/env node
// Fetch all owned gear from SplatNet 3 using nxapi's SplatNet3Api.getEquipment()
// Run inside the nxapi Docker container.

import { writeFileSync, mkdirSync } from 'fs';
import { init as initGlobals } from '/usr/local/lib/node_modules/nxapi/dist/common/globals.js';
import { getBulletToken } from '/usr/local/lib/node_modules/nxapi/dist/common/auth/splatnet3.js';
import { embedded_nxapi_auth_cli_client_id, pkg } from '/usr/local/lib/node_modules/nxapi/dist/util/product.js';
import { initStorage } from '/usr/local/lib/node_modules/nxapi/dist/util/storage.js';
import { NxapiClientAssertionProvider, setClientAssertionProvider } from '/usr/local/lib/node_modules/nxapi/dist/util/nxapi-auth.js';
import { addUserAgent } from '/usr/local/lib/node_modules/nxapi/dist/util/useragent.js';

initGlobals();
addUserAgent('splatoon-tools-fetch-equipment');
if (process.env.NXAPI_USER_AGENT) addUserAgent(process.env.NXAPI_USER_AGENT);

if (embedded_nxapi_auth_cli_client_id) {
    setClientAssertionProvider(new NxapiClientAssertionProvider(embedded_nxapi_auth_cli_client_id, undefined, 'ca:gf ca:er ca:dr ca:na'));
} else if (pkg.__nxapi_auth?.cli?.client_id) {
    setClientAssertionProvider(new NxapiClientAssertionProvider(pkg.__nxapi_auth.cli.client_id, undefined, 'ca:gf ca:er ca:dr ca:na'));
} else if (process.env.NXAPI_AUTH_CLIENT_ID) {
    setClientAssertionProvider(new NxapiClientAssertionProvider(process.env.NXAPI_AUTH_CLIENT_ID, undefined, process.env.NXAPI_AUTH_SCOPE ?? 'ca:gf ca:er ca:dr'));
} else {
    console.error('nxapi の Znca クライアント ID が見つかりません。');
    process.exit(1);
}

const dataPath = process.env.NXAPI_DATA_PATH ?? '/data';
const storage = await initStorage(dataPath);
const usernsid = await storage.getItem('SelectedUser');
const token = await storage.getItem('NintendoAccountToken.' + usernsid);
const { splatnet } = await getBulletToken(storage, token, undefined, true);
const result = await splatnet.getEquipment();
const outDir = `${dataPath}/data/splatnet3`;
mkdirSync(outDir, { recursive: true });
const outPath = `${outDir}/splatnet3-equipment.json`;
writeFileSync(outPath, JSON.stringify(result, null, 2));
process.stderr.write(`Saved to ${outPath}\n`);
