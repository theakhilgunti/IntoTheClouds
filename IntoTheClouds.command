#!/bin/bash
# Double-click in Finder to start everything.
cd "$(dirname "$0")" && ./intotheclouds.sh start; echo; read -n1 -p "Press any key to close (rig keeps running)..."
