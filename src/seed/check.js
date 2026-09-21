import { checkDb } from '../config/db.js';

checkDb()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
