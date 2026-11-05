// OpenViking twin of hs-client.mjs: SM_OV_URL (default http://127.0.0.1:1933), key SHARED_MEMORY_OPENVIKING_API_KEY from the environment.
import { makeClient } from './hs-client.mjs';

export const ov = (method, path, body, ms) => makeClient({ urlEnv: 'SM_OV_URL', urlDefault: 'http://127.0.0.1:1933', keyEnv: 'SHARED_MEMORY_OPENVIKING_API_KEY' })(method, path, body, ms);

// fs/ls answers {status, result: [{uri, size, isDir|is_dir}]}; both key spellings occur.
export const lsItems = (r) => (Array.isArray(r?.json?.result) ? r.json.result : []);
export const isDir = (e) => e.isDir === true || e.is_dir === true;
export const lsUrl = (uri, recursive = true) => `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}${recursive ? '&recursive=true' : ''}`;
