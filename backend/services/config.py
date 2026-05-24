"""
Shared configuration for backend services.

`firebase_client` is set by main.py at startup to avoid a circular import
where firebase_service.py would otherwise need to `import main`.
"""

firebase_client = None  # set by main.py before any request is served
