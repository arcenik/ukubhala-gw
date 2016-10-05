#! /bin/bash

clear

rm data/out.jpg # remove the image from the local server

curl -vs 'http://127.0.0.1:8080/photo/?md5=d24541edf63377bb47299b9c50149c13&name=out.jpg' \
    -H "Content-Type: application/octet-stream" \
    --data-binary @data/bla1.jpg

echo
echo ============================================================
ls -lh data/*.jpg # display the file as received by the server
echo ============================================================


