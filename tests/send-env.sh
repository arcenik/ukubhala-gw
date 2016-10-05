#! /bin/bash

clear

IP="192.168.1.234"
PORT="2180"

echo ================================================================================
curl -vs http://${IP}:${PORT}/log/env/ \
    -H "Content-Type: application/json" \
    -d '{"TempInBox": 4, "Humidity": 83, "Luminosity": 204, "CO2": 0}'
echo


