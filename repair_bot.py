#!/usr/bin/env python3
import binascii
import os

hex_file = os.path.expanduser('~/bot-24-7/index.js.hex')
target_file = os.path.expanduser('~/bot-24-7/index.js')

if not os.path.exists(hex_file):
    print("Hex file not found")
    exit(1)

# Read as binary to avoid encoding/BOM issues
with open(hex_file, 'rb') as hf:
    raw_data = hf.read()
    # Strip common UTF-16 BOMs and cast to string
    if raw_data.startswith(b'\xff\xfe') or raw_data.startswith(b'\xfe\xff'):
        hex_data = raw_data[2:].decode('utf-16').strip()
    elif raw_data.startswith(b'\xef\xbb\xbf'):
        hex_data = raw_data[3:].decode('utf-8').strip()
    else:
        hex_data = raw_data.decode('utf-8', errors='ignore').strip()

# Final safety: remove any non-hex characters (like space or newline)
hex_data = ''.join(c for c in hex_data if c in '0123456789abcdefABCDEF')

binary_data = binascii.unhexlify(hex_data)

with open(target_file, 'wb') as tf:
    tf.write(binary_data)

print(f"Restored successfully: {len(binary_data)} bytes")
