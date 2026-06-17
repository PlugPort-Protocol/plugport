const fs = require('fs');
const path = require('path');
const p = path.join('/Users/shankarwarang/Downloads/PlugPort v3/plugport/packages/server/src/__tests__/join-engine.test.ts');
let code = fs.readFileSync(p, 'utf8');

// We need to replace things like: engine.hashJoin(users, orders, '_id', 'user_id')
// with engine.hashJoin(users, orders, { onCondition: { leftField: '_id', rightField: 'user_id' }, leftAlias: 'u', rightAlias: 'o' })

code = code.replace(/engine\.(\w+Join)\(([^,]+),\s*([^,]+),\s*'([^']+)',\s*'([^']+)'\)/g, 
  "engine.$1($2, $3, { onCondition: { leftField: '$4', rightField: '$5' }, leftAlias: 'u', rightAlias: 'o', type: '$1'.replace('Join', '').toUpperCase() } as any)");

fs.writeFileSync(p, code);
console.log("Patched join-engine.test.ts");
