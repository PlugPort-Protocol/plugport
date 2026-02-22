// Package plugport provides a Go client library for PlugPort,
// offering a mongo-go-driver compatible API backed by HTTP transport.
//
// Usage:
//
//	client, err := plugport.Connect("http://localhost:8080")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	defer client.Close()
//
//	coll := client.Database("mydb").Collection("users")
//
//	// Insert
//	result, err := coll.InsertOne(ctx, map[string]interface{}{
//	    "name": "Alice",
//	    "email": "alice@example.com",
//	})
//
//	// Find
//	docs, err := coll.Find(ctx, map[string]interface{}{"name": "Alice"})
package plugport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client represents a PlugPort client connection.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// ClientOptions contains options for creating a client.
type ClientOptions struct {
	APIKey  string
	Timeout time.Duration
}

// Connect creates a new PlugPort client and verifies the connection.
func Connect(uri string, opts ...ClientOptions) (*Client, error) {
	var opt ClientOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	if opt.Timeout == 0 {
		opt.Timeout = 30 * time.Second
	}

	client := &Client{
		baseURL: uri,
		apiKey:  opt.APIKey,
		httpClient: &http.Client{
			Timeout: opt.Timeout,
		},
	}

	// Verify connection
	_, err := client.Health(context.Background())
	if err != nil {
		return nil, fmt.Errorf("failed to connect to %s: %w", uri, err)
	}

	return client, nil
}

// Database returns a database handle.
func (c *Client) Database(name string) *Database {
	return &Database{client: c, name: name}
}

// Health returns the server health status.
func (c *Client) Health(ctx context.Context) (map[string]interface{}, error) {
	return c.doGet(ctx, "/health")
}

// Close closes the client connection.
func (c *Client) Close() error {
	c.httpClient.CloseIdleConnections()
	return nil
}

func (c *Client) doGet(ctx context.Context, path string) (map[string]interface{}, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	return c.doRequest(req)
}

func (c *Client) doPost(ctx context.Context, path string, body interface{}) (map[string]interface{}, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.doRequest(req)
}

func (c *Client) doRequest(req *http.Request) (map[string]interface{}, error) {
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if resp.StatusCode >= 400 {
		msg, _ := result["errmsg"].(string)
		code, _ := result["code"].(float64)
		return nil, &PlugPortError{Code: int(code), Message: msg}
	}

	return result, nil
}

// PlugPortError represents an error from the PlugPort server.
type PlugPortError struct {
	Code    int
	Message string
}

func (e *PlugPortError) Error() string {
	return fmt.Sprintf("PlugPort error [%d]: %s", e.Code, e.Message)
}

// Database represents a PlugPort database.
type Database struct {
	client *Client
	name   string
}

// Collection returns a collection handle.
func (d *Database) Collection(name string) *Collection {
	return &Collection{db: d, name: name}
}

// ListCollectionNames returns the names of all collections.
func (d *Database) ListCollectionNames(ctx context.Context) ([]string, error) {
	result, err := d.client.doGet(ctx, "/api/v1/collections")
	if err != nil {
		return nil, err
	}

	collections, ok := result["collections"].([]interface{})
	if !ok {
		return []string{}, nil
	}

	names := make([]string, 0, len(collections))
	for _, c := range collections {
		if m, ok := c.(map[string]interface{}); ok {
			if name, ok := m["name"].(string); ok {
				names = append(names, name)
			}
		}
	}
	return names, nil
}

// Collection represents a PlugPort collection.
type Collection struct {
	db   *Database
	name string
}

// InsertResult represents the result of an insert operation.
type InsertResult struct {
	Acknowledged bool
	InsertedID   string
	InsertedCount int
}

// UpdateResult represents the result of an update operation.
type UpdateResult struct {
	Acknowledged  bool
	MatchedCount  int
	ModifiedCount int
	UpsertedID    string
}

// DeleteResult represents the result of a delete operation.
type DeleteResult struct {
	Acknowledged bool
	DeletedCount int
}

// InsertOne inserts a single document.
func (c *Collection) InsertOne(ctx context.Context, document interface{}) (*InsertResult, error) {
	result, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/insertOne", c.name), map[string]interface{}{
		"document": document,
	})
	if err != nil {
		return nil, err
	}

	return &InsertResult{
		Acknowledged: true,
		InsertedID:   fmt.Sprint(result["insertedId"]),
		InsertedCount: 1,
	}, nil
}

// InsertMany inserts multiple documents.
func (c *Collection) InsertMany(ctx context.Context, documents []interface{}) (*InsertResult, error) {
	result, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/insertMany", c.name), map[string]interface{}{
		"documents": documents,
	})
	if err != nil {
		return nil, err
	}

	count, _ := result["insertedCount"].(float64)
	return &InsertResult{
		Acknowledged:  true,
		InsertedCount: int(count),
	}, nil
}

// Find returns documents matching the filter.
func (c *Collection) Find(ctx context.Context, filter interface{}, opts ...FindOptions) ([]map[string]interface{}, error) {
	body := map[string]interface{}{
		"filter": filter,
	}
	if len(opts) > 0 {
		if opts[0].Limit > 0 {
			body["limit"] = opts[0].Limit
		}
		if opts[0].Skip > 0 {
			body["skip"] = opts[0].Skip
		}
		if opts[0].Sort != nil {
			body["sort"] = opts[0].Sort
		}
		if opts[0].Projection != nil {
			body["projection"] = opts[0].Projection
		}
	}

	result, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/find", c.name), body)
	if err != nil {
		return nil, err
	}

	cursor, ok := result["cursor"].(map[string]interface{})
	if !ok {
		return []map[string]interface{}{}, nil
	}

	batch, ok := cursor["firstBatch"].([]interface{})
	if !ok {
		return []map[string]interface{}{}, nil
	}

	docs := make([]map[string]interface{}, 0, len(batch))
	for _, d := range batch {
		if m, ok := d.(map[string]interface{}); ok {
			docs = append(docs, m)
		}
	}
	return docs, nil
}

// FindOne returns a single document matching the filter.
func (c *Collection) FindOne(ctx context.Context, filter interface{}) (map[string]interface{}, error) {
	result, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/findOne", c.name), map[string]interface{}{
		"filter": filter,
	})
	if err != nil {
		return nil, err
	}

	doc, ok := result["document"].(map[string]interface{})
	if !ok {
		return nil, nil
	}
	return doc, nil
}

// UpdateOne updates a single document matching the filter.
func (c *Collection) UpdateOne(ctx context.Context, filter interface{}, update interface{}, opts ...UpdateOptions) (*UpdateResult, error) {
	body := map[string]interface{}{
		"filter": filter,
		"update": update,
	}
	if len(opts) > 0 {
		body["upsert"] = opts[0].Upsert
	}

	result, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/updateOne", c.name), body)
	if err != nil {
		return nil, err
	}

	matched, _ := result["matchedCount"].(float64)
	modified, _ := result["modifiedCount"].(float64)
	return &UpdateResult{
		Acknowledged:  true,
		MatchedCount:  int(matched),
		ModifiedCount: int(modified),
	}, nil
}

// DeleteOne deletes a single document matching the filter.
func (c *Collection) DeleteOne(ctx context.Context, filter interface{}) (*DeleteResult, error) {
	result, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/deleteOne", c.name), map[string]interface{}{
		"filter": filter,
	})
	if err != nil {
		return nil, err
	}

	count, _ := result["deletedCount"].(float64)
	return &DeleteResult{
		Acknowledged: true,
		DeletedCount: int(count),
	}, nil
}

// DeleteMany deletes all documents matching the filter.
func (c *Collection) DeleteMany(ctx context.Context, filter interface{}) (*DeleteResult, error) {
	result, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/deleteMany", c.name), map[string]interface{}{
		"filter": filter,
	})
	if err != nil {
		return nil, err
	}

	count, _ := result["deletedCount"].(float64)
	return &DeleteResult{
		Acknowledged: true,
		DeletedCount: int(count),
	}, nil
}

// CreateIndex creates an index on a field.
func (c *Collection) CreateIndex(ctx context.Context, field string, unique bool) (string, error) {
	result, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/createIndex", c.name), map[string]interface{}{
		"field":  field,
		"unique": unique,
	})
	if err != nil {
		return "", err
	}

	name, _ := result["indexName"].(string)
	return name, nil
}

// Drop drops this collection.
func (c *Collection) Drop(ctx context.Context) error {
	_, err := c.db.client.doPost(ctx, fmt.Sprintf("/api/v1/collections/%s/drop", c.name), map[string]interface{}{})
	return err
}

// FindOptions contains options for Find operations.
type FindOptions struct {
	Limit      int
	Skip       int
	Sort       map[string]int
	Projection map[string]int
}

// UpdateOptions contains options for Update operations.
type UpdateOptions struct {
	Upsert bool
}
