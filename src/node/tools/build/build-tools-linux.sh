#!/usr/bin/env bash

set -e

rm -rf node_modules && npm install --dev && make clean tools
mkdir -p dist/node/tools/linux/bin
cp -r bins/opt/protobuf/protoc bins/opt/grpc_node_plugin src/node/tools/bin/google dist/node/tools/linux/bin/
tar -czf dist/node/tools/linux/linux-x64.tar.gz -C dist/node/tools/linux bin

