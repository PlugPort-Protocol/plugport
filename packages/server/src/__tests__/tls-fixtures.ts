// A self-signed certificate for localhost, for wire TLS tests only.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const TEST_CERT = path.join(FIXTURES, 'wire-tls-test.crt');
export const TEST_KEY = path.join(FIXTURES, 'wire-tls-test.key');
