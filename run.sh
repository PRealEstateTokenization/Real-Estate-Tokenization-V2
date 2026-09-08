#!/usr/bin/env bash
# Run the Parcel frontend (Sepolia — contracts already deployed).
cd "$(dirname "$0")"

# keep frontend config in sync with the latest deploy (harmless if unchanged)
if [ -f frontend-config/addresses.json ]; then
  cp -f frontend-config/addresses.json frontend/addresses.json
  cp -f frontend-config/abis.json      frontend/abis.json
fi

echo "Starting Parcel at http://localhost:4000  (Ctrl+C to stop)"
cd frontend
npx serve . -l 4000
