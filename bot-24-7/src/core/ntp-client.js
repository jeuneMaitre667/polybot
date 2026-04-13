import dgram from 'dgram';

/**
 * NTP Client (v17.52.0)
 * Calculates the offset between Local System Time and Network Time.
 */

const NTP_SERVER = 'pool.ntp.org';
const NTP_PORT = 123;
const TIMEOUT_MS = 5000;

/**
 * Fetches the current network time and calculates the local offset.
 * @returns {Promise<number>} Offset in milliseconds (NetworkTime - LocalTime)
 */
export async function getNTPOffset() {
    return new Promise((resolve, reject) => {
        const client = dgram.createSocket('udp4');
        const packet = Buffer.alloc(48);
        
        // NTP Packet Header: Leap Indicator = 0, Version = 3, Mode = 3 (Client)
        packet[0] = 0x1B;

        const timeout = setTimeout(() => {
            client.close();
            reject(new Error('NTP Timeout: Could not reach pool.ntp.org'));
        }, TIMEOUT_MS);

        client.on('error', (err) => {
            clearTimeout(timeout);
            client.close();
            reject(err);
        });

        client.on('message', (msg) => {
            clearTimeout(timeout);
            client.close();
            
            // Extract Transmit Timestamp from bytes 40-47
            // Seconds since Jan 1st 1900
            const seconds = msg.readUInt32BE(40);
            const fraction = msg.readUInt32BE(44);
            
            // Convert to Unix Timestamp (Epoch is 1970)
            const ntpEpoch = 2208988800;
            const networkTimeMs = (seconds - ntpEpoch) * 1000 + Math.floor((fraction / 0x100000000) * 1000);
            const localTimeMs = Date.now();
            
            const offset = networkTimeMs - localTimeMs;
            resolve(offset);
        });

        client.send(packet, 0, 48, NTP_PORT, NTP_SERVER, (err) => {
            if (err) {
                clearTimeout(timeout);
                client.close();
                reject(err);
            }
        });
    });
}

/**
 * Periodically refreshes the offset to counter system clock drift.
 */
export class TimeKeeper {
    constructor() {
        this.offset = 0;
        this.lastSync = 0;
    }

    async sync() {
        try {
            console.log('[NTP] Synchronisation en cours avec pool.ntp.org...');
            this.offset = await getNTPOffset();
            this.lastSync = Date.now();
            console.log(`[NTP] Décalage détecté : ${this.offset > 0 ? '+' : ''}${this.offset}ms. Horloge virtuelle recalibrée.`);
            return this.offset;
        } catch (err) {
            console.error('[NTP] ⚠️ Échec de synchronisation:', err.message);
            return this.offset; // Keep old offset or 0
        }
    }

    getNow() {
        return Date.now() + this.offset;
    }
}

export const timeKeeper = new TimeKeeper();
