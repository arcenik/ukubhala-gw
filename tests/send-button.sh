#! /bin/bash

clear

IP="192.168.1.234"
PORT="2180"

echo ================================================================================
curl -vs http://${IP}:${PORT}/log/button/ \
    -H "Content-Type: application/json" \
    -d '{"Button": "car", "timestamp": "2015-06-15 10:05:50", "ts-s": 13378, "ts-ms": 131}'
echo

echo ================================================================================
curl -vs http://${IP}:${PORT}/log/button/ \
    -H "Content-Type: application/json" \
    -d '{"Button": "bike", "timestamp": "2015-06-15 10:05:51", "ts-s": 13378, "ts-ms": 531}'
echo

echo ================================================================================
curl -vs http://${IP}:${PORT}/log/button/ \
    -H "Content-Type: application/json" \
    -d '{"Button": "people", "timestamp": "2015-06-15 10:05:51", "ts-s": 13378, "ts-ms": 931}'
echo


