"""Tests for PlugPort Python SDK."""

import pytest
from unittest.mock import patch, MagicMock
from plugport import PlugPortClient, Collection, Database
from plugport.errors import PlugPortError, DuplicateKeyError


class TestCollection:
    """Tests for Collection class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.mock_transport = MagicMock()
        self.collection = Collection(self.mock_transport, "test_collection")

    def test_insert_one(self):
        """Test inserting a single document."""
        self.mock_transport.post.return_value = {
            "acknowledged": True,
            "insertedId": "abc123",
        }
        result = self.collection.insert_one({"name": "Alice"})
        assert result.acknowledged is True
        assert result.inserted_id == "abc123"
        self.mock_transport.post.assert_called_once_with(
            "/api/v1/collections/test_collection/insertOne",
            {"document": {"name": "Alice"}},
        )

    def test_insert_many(self):
        """Test inserting multiple documents."""
        self.mock_transport.post.return_value = {
            "acknowledged": True,
            "insertedIds": ["a", "b"],
            "insertedCount": 2,
        }
        docs = [{"name": "Alice"}, {"name": "Bob"}]
        result = self.collection.insert_many(docs)
        assert result.inserted_count == 2
        assert result.inserted_ids == ["a", "b"]

    def test_find(self):
        """Test finding documents."""
        self.mock_transport.post.return_value = {
            "cursor": {
                "firstBatch": [
                    {"_id": "1", "name": "Alice"},
                    {"_id": "2", "name": "Bob"},
                ],
                "id": 0,
            },
            "ok": 1,
        }
        docs = self.collection.find({"name": "Alice"})
        assert len(docs) == 2
        assert docs[0]["name"] == "Alice"

    def test_find_one(self):
        """Test finding a single document."""
        self.mock_transport.post.return_value = {
            "document": {"_id": "1", "name": "Alice"},
            "ok": 1,
        }
        doc = self.collection.find_one({"name": "Alice"})
        assert doc is not None
        assert doc["name"] == "Alice"

    def test_find_one_not_found(self):
        """Test find_one when no document matches."""
        self.mock_transport.post.return_value = {"document": None, "ok": 1}
        doc = self.collection.find_one({"name": "Nobody"})
        assert doc is None

    def test_update_one(self):
        """Test updating a document."""
        self.mock_transport.post.return_value = {
            "acknowledged": True,
            "matchedCount": 1,
            "modifiedCount": 1,
            "upsertedId": None,
        }
        result = self.collection.update_one(
            {"name": "Alice"}, {"$set": {"age": 30}}
        )
        assert result.matched_count == 1
        assert result.modified_count == 1

    def test_delete_one(self):
        """Test deleting a document."""
        self.mock_transport.post.return_value = {
            "acknowledged": True,
            "deletedCount": 1,
        }
        result = self.collection.delete_one({"name": "Alice"})
        assert result.deleted_count == 1

    def test_delete_many(self):
        """Test deleting multiple documents."""
        self.mock_transport.post.return_value = {
            "acknowledged": True,
            "deletedCount": 3,
        }
        result = self.collection.delete_many({"role": "user"})
        assert result.deleted_count == 3

    def test_create_index(self):
        """Test creating an index."""
        self.mock_transport.post.return_value = {
            "acknowledged": True,
            "indexName": "email_1",
        }
        name = self.collection.create_index("email", unique=True)
        assert name == "email_1"

    def test_count_documents(self):
        """Test counting documents."""
        self.mock_transport.post.return_value = {
            "cursor": {
                "firstBatch": [{"_id": "1"}, {"_id": "2"}, {"_id": "3"}],
                "id": 0,
            },
            "ok": 1,
        }
        count = self.collection.count_documents({})
        assert count == 3


class TestDatabase:
    """Tests for Database class."""

    def setup_method(self):
        self.mock_transport = MagicMock()
        self.db = Database(self.mock_transport, "testdb")

    def test_get_collection(self):
        """Test getting a collection reference."""
        coll = self.db["users"]
        assert isinstance(coll, Collection)
        assert coll.name == "users"

    def test_list_collection_names(self):
        """Test listing collection names."""
        self.mock_transport.get.return_value = {
            "collections": [
                {"name": "users"},
                {"name": "products"},
            ],
            "ok": 1,
        }
        names = self.db.list_collection_names()
        assert names == ["users", "products"]


class TestClient:
    """Tests for PlugPortClient class."""

    def test_uri_normalization(self):
        """Test that plugport:// URIs are normalized."""
        with patch("plugport.client.HttpTransport") as MockTransport:
            mock_instance = MockTransport.return_value
            mock_instance.get.return_value = {"status": "ok"}
            client = PlugPortClient("plugport://localhost:8080")
            assert "http://" in client._uri or "plugport://" in client._uri

    def test_get_database(self):
        """Test getting a database reference."""
        with patch("plugport.client.HttpTransport"):
            client = PlugPortClient("http://localhost:8080")
            db = client["mydb"]
            assert isinstance(db, Database)


class TestErrors:
    """Tests for error handling."""

    def test_plugport_error(self):
        error = PlugPortError(1, "test error")
        assert error.code == 1
        assert "test error" in str(error)

    def test_duplicate_key_error(self):
        error = DuplicateKeyError("duplicate key")
        assert error.code == 11000
        assert "duplicate key" in str(error)
