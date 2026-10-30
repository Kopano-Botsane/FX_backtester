"""Frozen entry point.

PyInstaller cannot use `app/main.py` directly because that module uses
package-relative imports. This shim keeps the package context intact:

    .venv/bin/python run.py --port 8000
    backend/dist/backtester-backend --port 8000     # after build_backend.sh
"""

from app.main import main

if __name__ == "__main__":
    main()
