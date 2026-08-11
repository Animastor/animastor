#!/usr/bin/env bash

mkdir -p ~/animastor/logs

echo "Bootstrap started" >> ~/animastor/logs/bootstrap.log

sleep 5

bash ~/animastor/start-worker.sh >> ~/animastor/logs/bootstrap.log 2>&1 &
