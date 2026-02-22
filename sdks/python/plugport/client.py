"""
PlugPort Python Client
PyMongo-compatible shim with HTTP API transport.

Usage:
    from plugport import PlugPortClient

    client = PlugPortClient("http://localhost:8080")
    db = client["mydb"]
    collection = db["users"]

    # Insert
    result = collection.insert_one({"name": "Alice", "email": "alice@example.com"})

    # Find
    docs = collection.find({"name": "Alice"})

    # Update
    collection.update_one({"name": "Alice"}, {"$set": {"age": 30}})

    # Delete
    collection.delete_one({"name": "Alice"})
"""

from typing import Any, Dict, List, Optional, Union
import requests
from .errors import PlugPortError, DuplicateKeyError, ConnectionError


class InsertOneResult:
    """Result of an insert_one operation."""

    def __init__(self, data: dict):
        self.acknowledged = data.get("acknowledged", True)
        self.inserted_id = data.get("insertedId")

    def __repr__(self):
        return f"InsertOneResult(acknowledged={self.acknowledged}, inserted_id='{self.inserted_id}')"


class InsertManyResult:
    """Result of an insert_many operation."""

    def __init__(self, data: dict):
        self.acknowledged = data.get("acknowledged", True)
        self.inserted_ids = data.get("insertedIds", [])
        self.inserted_count = data.get("insertedCount", 0)


class UpdateResult:
    """Result of an update operation."""

    def __init__(self, data: dict):
        self.acknowledged = data.get("acknowledged", True)
        self.matched_count = data.get("matchedCount", 0)
        self.modified_count = data.get("modifiedCount", 0)
        self.upserted_id = data.get("upsertedId")

    def __repr__(self):
        return f"UpdateResult(matched={self.matched_count}, modified={self.modified_count})"


class DeleteResult:
    """Result of a delete operation."""

    def __init__(self, data: dict):
        self.acknowledged = data.get("acknowledged", True)
        self.deleted_count = data.get("deletedCount", 0)

    def __repr__(self):
        return f"DeleteResult(deleted={self.deleted_count})"


class Collection:
    """Represents a PlugPort collection. PyMongo-compatible API."""

    def __init__(self, transport: "HttpTransport", name: str):
        self._transport = transport
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def insert_one(self, document: dict) -> InsertOneResult:
        """Insert a single document."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/insertOne",
            {"document": document},
        )
        return InsertOneResult(result)

    def insert_many(self, documents: List[dict]) -> InsertManyResult:
        """Insert multiple documents."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/insertMany",
            {"documents": documents},
        )
        return InsertManyResult(result)

    def find(
        self,
        filter: Optional[dict] = None,
        projection: Optional[dict] = None,
        sort: Optional[dict] = None,
        limit: int = 0,
        skip: int = 0,
    ) -> List[dict]:
        """Find documents matching a filter."""
        body: Dict[str, Any] = {"filter": filter or {}}
        if projection:
            body["projection"] = projection
        if sort:
            body["sort"] = sort
        if limit:
            body["limit"] = limit
        if skip:
            body["skip"] = skip

        result = self._transport.post(
            f"/api/v1/collections/{self._name}/find", body
        )
        return result.get("cursor", {}).get("firstBatch", [])

    def find_one(
        self,
        filter: Optional[dict] = None,
        projection: Optional[dict] = None,
    ) -> Optional[dict]:
        """Find a single document matching a filter."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/findOne",
            {"filter": filter or {}, "projection": projection},
        )
        return result.get("document")

    def update_one(
        self,
        filter: dict,
        update: dict,
        upsert: bool = False,
    ) -> UpdateResult:
        """Update a single document matching a filter."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/updateOne",
            {"filter": filter, "update": update, "upsert": upsert},
        )
        return UpdateResult(result)

    def update_many(
        self,
        filter: dict,
        update: dict,
        upsert: bool = False,
    ) -> UpdateResult:
        """Update multiple documents matching a filter."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/updateMany",
            {"filter": filter, "update": update, "upsert": upsert},
        )
        return UpdateResult(result)

    def delete_one(self, filter: dict) -> DeleteResult:
        """Delete a single document matching a filter."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/deleteOne",
            {"filter": filter},
        )
        return DeleteResult(result)

    def delete_many(self, filter: dict) -> DeleteResult:
        """Delete multiple documents matching a filter."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/deleteMany",
            {"filter": filter},
        )
        return DeleteResult(result)

    def count_documents(self, filter: Optional[dict] = None) -> int:
        """Count documents matching a filter (server-side)."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/count",
            {"filter": filter or {}},
        )
        return result.get("count", 0)

    def estimated_document_count(self) -> int:
        """Estimate total document count in collection."""
        return self.count_documents()

    def distinct(self, field: str, filter: Optional[dict] = None) -> list:
        """Get distinct values for a field."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/distinct",
            {"field": field, "filter": filter or {}},
        )
        return result.get("values", [])

    def create_index(self, field: str, unique: bool = False) -> str:
        """Create an index on a field."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/createIndex",
            {"field": field, "unique": unique},
        )
        return result.get("indexName", "")

    def drop_index(self, index_name: str) -> bool:
        """Drop an index by name."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/dropIndex",
            {"indexName": index_name},
        )
        return result.get("dropped", False)

    def list_indexes(self) -> List[dict]:
        """List all indexes on this collection."""
        result = self._transport.get(
            f"/api/v1/collections/{self._name}/indexes"
        )
        return result.get("indexes", [])

    def drop(self) -> bool:
        """Drop this collection."""
        result = self._transport.post(
            f"/api/v1/collections/{self._name}/drop", {}
        )
        return result.get("dropped", False)


class Database:
    """Represents a PlugPort database. PyMongo-compatible API."""

    def __init__(self, transport: "HttpTransport", name: str):
        self._transport = transport
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def __getitem__(self, name: str) -> Collection:
        return self.get_collection(name)

    def __getattr__(self, name: str) -> Collection:
        if name.startswith("_"):
            raise AttributeError(name)
        return self.get_collection(name)

    def get_collection(self, name: str) -> Collection:
        """Get a collection by name."""
        return Collection(self._transport, name)

    def list_collection_names(self) -> List[str]:
        """List all collection names."""
        result = self._transport.get("/api/v1/collections")
        return [c["name"] for c in result.get("collections", [])]

    def drop_collection(self, name: str) -> bool:
        """Drop a collection."""
        result = self._transport.post(
            f"/api/v1/collections/{name}/drop", {}
        )
        return result.get("dropped", False)

    def create_collection(self, name: str) -> Collection:
        """Create a collection."""
        self._transport.post(
            f"/api/v1/collections/{name}/insertOne",
            {"document": {"_plugport_init": True}},
        )
        return Collection(self._transport, name)


class HttpTransport:
    """HTTP transport layer for PlugPort API calls."""

    def __init__(self, base_url: str, api_key: Optional[str] = None):
        self._base_url = base_url.rstrip("/")
        self._session = requests.Session()
        self._session.headers.update({"Content-Type": "application/json"})
        if api_key:
            self._session.headers.update({"Authorization": f"Bearer {api_key}"})
        self._timeout = 30  # Default 30s timeout to prevent infinite blocking

    def get(self, path: str) -> dict:
        """Make a GET request with exponential backoff for rate limits."""
        import time
        max_retries = 3
        
        for attempt in range(max_retries + 1):
            try:
                resp = self._session.get(f"{self._base_url}{path}", timeout=self._timeout)
                if resp.status_code == 429 and attempt < max_retries:
                    time.sleep(2 ** attempt)
                    continue
                return self._handle_response(resp)
            except requests.Timeout:
                if attempt < max_retries:
                    time.sleep(2 ** attempt)
                    continue
                raise ConnectionError(f"Request timed out after {self._timeout}s")
            except requests.ConnectionError as e:
                raise ConnectionError(str(e))

    def post(self, path: str, body: dict) -> dict:
        """Make a POST request with exponential backoff for rate limits."""
        import time
        max_retries = 3

        for attempt in range(max_retries + 1):
            try:
                resp = self._session.post(f"{self._base_url}{path}", json=body, timeout=self._timeout)
                if resp.status_code == 429 and attempt < max_retries:
                    time.sleep(2 ** attempt)
                    continue
                return self._handle_response(resp)
            except requests.Timeout:
                if attempt < max_retries:
                    time.sleep(2 ** attempt)
                    continue
                raise ConnectionError(f"Request timed out after {self._timeout}s")
            except requests.ConnectionError as e:
                raise ConnectionError(str(e))

    def _handle_response(self, resp: requests.Response) -> dict:
        """Handle HTTP response, raising appropriate errors."""
        data = resp.json()
        if resp.status_code >= 400:
            code = data.get("code", resp.status_code)
            msg = data.get("errmsg", "Unknown error")
            if code == 11000:
                raise DuplicateKeyError(msg)
            raise PlugPortError(code, msg)
        return data

    def close(self):
        """Close the HTTP session."""
        self._session.close()


class PlugPortClient:
    """
    PlugPort Client - PyMongo-compatible interface.

    Usage:
        client = PlugPortClient("http://localhost:8080")
        db = client["mydb"]
        users = db["users"]
        users.insert_one({"name": "Alice"})
    """

    def __init__(
        self,
        uri: str = "http://localhost:8080",
        api_key: Optional[str] = None,
    ):
        if uri.startswith("plugport://"):
            uri = uri.replace("plugport://", "http://")

        self._transport = HttpTransport(uri, api_key)
        self._uri = uri

    def __getitem__(self, name: str) -> Database:
        return self.get_database(name)

    def __getattr__(self, name: str) -> Database:
        if name.startswith("_"):
            raise AttributeError(name)
        return self.get_database(name)

    def get_database(self, name: str = "default") -> Database:
        """Get a database by name."""
        return Database(self._transport, name)

    def server_info(self) -> dict:
        """Get server health info."""
        return self._transport.get("/health")

    def list_database_names(self) -> List[str]:
        """List database names (PlugPort uses a single logical database)."""
        return ["default"]

    def close(self):
        """Close the client connection."""
        self._transport.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __repr__(self):
        return f"PlugPortClient(uri='{self._uri}')"
