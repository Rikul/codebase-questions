import { mintCode, printCode } from '../auth.js';
import { config } from '../config.js';
import { openDb } from '../db/index.js';

// Mint a fresh one-time access code (invalidates any unused code). Existing sessions stay valid.
const db = openDb(config.dbPath);
printCode(mintCode(db), 'New access code');
db.close();
