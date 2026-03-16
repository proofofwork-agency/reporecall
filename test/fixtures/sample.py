"""Database connection module."""

import sqlite3
from dataclasses import dataclass
from typing import Optional


@dataclass
class DBConfig:
    host: str
    port: int = 5432
    database: str = "app"
    user: str = "postgres"
    password: Optional[str] = None


class DatabaseConnection:
    """Manages database connections with connection pooling."""

    def __init__(self, config: DBConfig):
        self.config = config
        self._pool = []

    def connect(self):
        """Establish a new database connection."""
        conn = sqlite3.connect(self.config.database)
        self._pool.append(conn)
        return conn

    def close_all(self):
        """Close all pooled connections."""
        for conn in self._pool:
            conn.close()
        self._pool.clear()


def create_tables(conn):
    """Create initial database tables."""
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE
        )
    """)
    conn.commit()
