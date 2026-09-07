#!/bin/bash

nohup bash -c '
sleep 35

apt update -y
apt install -y mc

echo "alias mc=\"/usr/bin/mc\"" >> ~/.bashrc
' > /var/log/install_mc.log 2>&1 &
