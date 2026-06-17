const { Parser } = require('node-sql-parser');
const parser = new Parser();
console.log("INSERT", JSON.stringify(parser.astify("INSERT INTO users (id, name) VALUES (1, 'Alice')", { database: 'PostgreSQL' })));
console.log("UPDATE", JSON.stringify(parser.astify("UPDATE users SET name = 'Bob' WHERE id = 1", { database: 'PostgreSQL' })));
console.log("DELETE", JSON.stringify(parser.astify("DELETE FROM users WHERE id = 1", { database: 'PostgreSQL' })));
console.log("SELECT IN", JSON.stringify(parser.astify("SELECT * FROM users WHERE role IN ('admin', 'moderator')", { database: 'PostgreSQL' })));
console.log("CREATE INDEX", JSON.stringify(parser.astify("CREATE INDEX email ON users (email)", { database: 'PostgreSQL' })));
console.log("JOIN", JSON.stringify(parser.astify("SELECT * FROM users u LEFT JOIN orders o ON u.id = o.user_id", { database: 'PostgreSQL' })));
