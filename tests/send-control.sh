#! /bin/bash

clear

IP="192.168.1.234"
PORT="2180"

echo ================================================================================
curl -vs http://${IP}:${PORT}/log/control/ \
    -H "Content-Type: application/json" \
    -d '{"name": "error", "datetime": "2015-06-15 10:07:46", "value": "acquisition board not responding"}'
echo
