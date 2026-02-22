---
id: python
title: Python SDK
sidebar_label: Python
sidebar_position: 2
---

# Python SDK

The `plugport` Python package provides a PyMongo-compatible API. If you've used PyMongo, you already know this SDK.

## Installation

```bash
pip install plugport
```

## Quick Start

```python
from plugport import PlugPortClient

client = PlugPortClient("http://localhost:8080")
db = client["myapp"]
users = db["users"]

# Insert
result = users.insert_one({"name": "Alice", "email": "alice@example.com", "age": 30})
print(f"Inserted: {result.inserted_id}")

# Find
docs = users.find({"age": {"$gte": 25}})
for doc in docs:
    print(doc)

client.close()
```

## PyMongo Compatibility

The SDK mirrors PyMongo's API patterns:

```python
# Dict-style access (just like PyMongo)
db = client["mydb"]
collection = db["users"]

# Attribute-style access
db = client.mydb
collection = db.users

# Context manager
with PlugPortClient("http://localhost:8080") as client:
    db = client["myapp"]
    # Auto-closes on exit
```

## API Reference

### `PlugPortClient(uri, api_key=None)`

```python
# Basic connection
client = PlugPortClient("http://localhost:8080")

# With API key
client = PlugPortClient("http://localhost:8080", api_key="your-key")

# Using plugport:// scheme
client = PlugPortClient("plugport://localhost:8080")
```

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `client["name"]` | `Database` | Get database by name |
| `client.get_database(name)` | `Database` | Get database by name |
| `client.server_info()` | `dict` | Server health info |
| `client.list_database_names()` | `list[str]` | List databases |
| `client.close()` | `None` | Close connection |

### `Database`

```python
db = client["myapp"]

# List collections
names = db.list_collection_names()

# Drop a collection
db.drop_collection("users")
```

### `Collection`

#### `insert_one(document) -> InsertOneResult`

```python
result = users.insert_one({"name": "Alice", "email": "alice@example.com"})
print(result.acknowledged)  # True
print(result.inserted_id)   # "67b2a1f0..."
```

#### `insert_many(documents) -> InsertManyResult`

```python
result = users.insert_many([
    {"name": "Alice", "age": 30},
    {"name": "Bob", "age": 25},
])
print(result.inserted_count)  # 2
print(result.inserted_ids)    # ["...", "..."]
```

#### `find(filter=None, projection=None, sort=None, limit=0, skip=0) -> list[dict]`

```python
# All documents
docs = users.find()

# With filter
docs = users.find({"age": {"$gte": 18}})

# With all options
docs = users.find(
    filter={"status": "active"},
    projection={"name": 1, "score": 1},
    sort={"score": -1},
    limit=10,
    skip=0,
)
```

#### `find_one(filter=None) -> dict | None`

```python
user = users.find_one({"email": "alice@example.com"})
if user:
    print(user["name"])
```

#### `update_one(filter, update, upsert=False) -> UpdateResult`

```python
result = users.update_one(
    {"name": "Alice"},
    {"$set": {"age": 31}},
    upsert=False,
)
print(result.matched_count)   # 1
print(result.modified_count)  # 1
```

#### `delete_one(filter) -> DeleteResult`

```python
result = users.delete_one({"name": "Alice"})
print(result.deleted_count)  # 1
```

#### `delete_many(filter) -> DeleteResult`

```python
result = users.delete_many({"status": "inactive"})
print(result.deleted_count)  # 5
```

#### `create_index(field, unique=False) -> str`

```python
index_name = users.create_index("email", unique=True)
# "email_1"
```

#### `count_documents(filter=None) -> int`

```python
count = users.count_documents({"status": "active"})
```

## Error Handling

```python
from plugport.errors import PlugPortError, DuplicateKeyError, ConnectionError

try:
    users.insert_one({"email": "alice@example.com"})
except DuplicateKeyError as e:
    print(f"Duplicate: {e.message}")  # code: 11000
except ConnectionError as e:
    print(f"Connection failed: {e.message}")
except PlugPortError as e:
    print(f"Error [{e.code}]: {e.message}")
```

## Migration from PyMongo

```diff
- from pymongo import MongoClient
+ from plugport import PlugPortClient

- client = MongoClient("mongodb://localhost:27017")
+ client = PlugPortClient("http://localhost:8080")

  # All code below is identical
  db = client["myapp"]
  users = db["users"]
  users.insert_one({"name": "Alice"})
  users.find({"age": {"$gte": 25}})
```
