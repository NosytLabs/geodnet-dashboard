#!/bin/bash
# GEODNET dashboard launcher — used by the Windows Scheduled Task.
cd "C:/Users/Tyson/Projects/geodnet-dashboard" || exit 1
exec node server.js
