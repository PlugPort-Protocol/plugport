---
id: go
title: Go SDK
sidebar_label: Go
sidebar_position: 3
---

# Go Client Library

The `plugport-go` package provides a `mongo-go-driver` compatible API for Go applications.

## Installation

```bash
go get github.com/plugport/plugport-go
```

## Quick Start

```go
package main

import (
    "context"
    "fmt"
    "log"

    plugport "github.com/plugport/plugport-go"
)

func main() {
    ctx := context.Background()

    client, err := plugport.Connect("http://localhost:8080")
    if err != nil {
        log.Fatal(err)
    }
    defer client.Close()

    coll := client.Database("myapp").Collection("users")

    // Insert
    result, err := coll.InsertOne(ctx, map[string]interface{}{
        "name":  "Alice",
        "email": "alice@example.com",
        "age":   30,
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Inserted: %s\n", result.InsertedID)

    // Find
    docs, err := coll.Find(ctx, map[string]interface{}{
        "age": map[string]interface{}{"$gte": 25},
    })
    if err != nil {
        log.Fatal(err)
    }
    for _, doc := range docs {
        fmt.Printf("Found: %v\n", doc["name"])
    }
}
```

## API Reference

### `Connect(uri string, opts ...ClientOptions) (*Client, error)`

```go
// Basic
client, err := plugport.Connect("http://localhost:8080")

// With options
client, err := plugport.Connect("http://localhost:8080", plugport.ClientOptions{
    APIKey:  "your-key",
    Timeout: 30 * time.Second,
})
```

### `Client`

| Method | Description |
|--------|-------------|
| `Database(name)` | Get a `*Database` handle |
| `Health(ctx)` | Get server health |
| `Close()` | Close the connection |

### `Database`

| Method | Description |
|--------|-------------|
| `Collection(name)` | Get a `*Collection` handle |
| `ListCollectionNames(ctx)` | List collection names |

### `Collection`

#### Insert

```go
// Single document
result, err := coll.InsertOne(ctx, doc)
// result.InsertedID, result.InsertedCount

// Multiple documents
result, err := coll.InsertMany(ctx, []interface{}{doc1, doc2})
// result.InsertedCount
```

#### Find

```go
// Basic find
docs, err := coll.Find(ctx, filter)

// With options
docs, err := coll.Find(ctx, filter, plugport.FindOptions{
    Limit:      10,
    Skip:       0,
    Sort:       map[string]int{"age": -1},
    Projection: map[string]int{"name": 1, "age": 1},
})

// Find one
doc, err := coll.FindOne(ctx, filter)
```

#### Update

```go
result, err := coll.UpdateOne(ctx, filter, update)
// result.MatchedCount, result.ModifiedCount

// With upsert
result, err := coll.UpdateOne(ctx, filter, update, plugport.UpdateOptions{
    Upsert: true,
})
```

#### Delete

```go
result, err := coll.DeleteOne(ctx, filter)
// result.DeletedCount

result, err := coll.DeleteMany(ctx, filter)
```

#### Indexes

```go
name, err := coll.CreateIndex(ctx, "email", true) // unique
err = coll.Drop(ctx)
```

## Error Handling

```go
result, err := coll.InsertOne(ctx, doc)
if err != nil {
    var plugportErr *plugport.PlugPortError
    if errors.As(err, &plugportErr) {
        fmt.Printf("Code: %d, Message: %s\n", plugportErr.Code, plugportErr.Message)
    }
}
```

## Migration from mongo-go-driver

```diff
- import "go.mongodb.org/mongo-driver/mongo"
- import "go.mongodb.org/mongo-driver/mongo/options"
+ import plugport "github.com/plugport/plugport-go"

- client, err := mongo.Connect(ctx, options.Client().ApplyURI("mongodb://localhost:27017"))
+ client, err := plugport.Connect("http://localhost:8080")

  coll := client.Database("myapp").Collection("users")
  // All CRUD operations use the same API
```
