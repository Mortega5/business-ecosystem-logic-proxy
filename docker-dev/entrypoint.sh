#!/usr/bin/env bash

cd /business-ecosystem-logic-proxy
pnpm install --frozen-lockfile

echo "Proxy-dev deployed"

while true; do sleep 1000; done
