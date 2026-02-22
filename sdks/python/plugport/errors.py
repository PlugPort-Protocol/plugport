"""Custom error classes for PlugPort Python SDK."""


class PlugPortError(Exception):
    """Base exception for PlugPort operations."""

    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


class DuplicateKeyError(PlugPortError):
    """Raised when a unique index constraint is violated."""

    def __init__(self, message: str):
        super().__init__(11000, message)


class ConnectionError(PlugPortError):
    """Raised when connection to PlugPort server fails."""

    def __init__(self, message: str):
        super().__init__(0, message)


class NamespaceNotFoundError(PlugPortError):
    """Raised when a collection is not found."""

    def __init__(self, collection: str):
        super().__init__(26, f"Collection '{collection}' not found")


class DocumentTooLargeError(PlugPortError):
    """Raised when a document exceeds the maximum size."""

    def __init__(self, size: int, max_size: int):
        super().__init__(10334, f"Document size {size} exceeds max {max_size}")
