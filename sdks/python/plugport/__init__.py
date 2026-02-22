"""
PlugPort Python SDK
MongoDB-compatible client for PlugPort, backed by MonadDb.
Acts as a PyMongo shim with HTTP API under the hood.
"""

from .client import PlugPortClient, Database, Collection
from .errors import PlugPortError, DuplicateKeyError, ConnectionError

__version__ = "1.0.0"
__all__ = [
    "PlugPortClient",
    "Database",
    "Collection",
    "PlugPortError",
    "DuplicateKeyError",
    "ConnectionError",
]
