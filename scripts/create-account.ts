import { Accounts, encryptionKey } from '../server/accounts.ts';
import { Store } from '../server/store.ts';
import { credentials } from '../server/providers.ts';
process.umask(0o077);
const [name, option] = process.argv.slice(2);
if (!name || (option && option !== '--claim-local')) throw new Error('Usage: npx tsx scripts/create-account.ts USERNAME [--claim-local], with password on stdin.');
let password = '';
for await (const chunk of process.stdin) { password += chunk; if (password.length > 258) throw new Error('Password too long.'); }
password = password.replace(/\r?\n$/, '');
const store = new Store();
try {
  const accounts = new Accounts(store.db, encryptionKey('data/credentials.key', store.db));
  const user = await accounts.create(name, password);
  if (option === '--claim-local') {
    try { accounts.claimLocal(user.id, credentials()); }
    catch (error) { store.db.prepare('DELETE FROM users WHERE id=?').run(user.id); throw error; }
  }
  console.log(`Created account ${user.name}.${option ? ' Existing local records and connections assigned to this account.' : ' Workspace starts empty.'}`);
} finally { store.db.close(); }
