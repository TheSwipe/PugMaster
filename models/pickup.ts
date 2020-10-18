import { PickupSettings } from '../core/types';
import db from '../core/db';
import { transaction } from '../core/db';
import { PoolConnection } from 'mysql2/promise';

export default class PickupModel {
    private constructor() { }

    static async areValidPickups(guildId: bigint, ...pickups): Promise<{ name: string; id: number }[]> {
        const results: any = await db.execute(`
        SELECT name, id FROM pickup_configs
        WHERE guild_id = ? AND name IN (${Array(pickups.length).fill('?').join(',')})
        `, [guildId, ...pickups])

        return results[0];
    }

    static async createPickups(guildId: bigint, ...pickups: { name: string; playerCount: number, teamCount?: number }[]) {
        for (const pickup of pickups) {
            await db.execute(`
            INSERT INTO pickup_configs 
            (guild_id, name, player_count, team_count)
            VALUES (?, ?, ?, IFNULL(?,DEFAULT(team_count)))
            `, [guildId, pickup.name, pickup.playerCount, pickup.teamCount || null]);
        }
        return;
    }

    static async removePickups(guildId: bigint, ...pickupConfigIds) {
        await db.execute(`
        DELETE FROM pickup_configs
        WHERE guild_id = ? AND id IN (${Array(pickupConfigIds.length).fill('?').join(',')}) 
        `, [guildId, ...pickupConfigIds]);
    }

    static async getActivePickup(guildId: bigint, nameOrConfigId: number | string):
        Promise<{ name: string, players: { id: string | null, nick: string }[]; maxPlayers: number; teams: number; configId: number }> {
        let result;

        if (typeof nameOrConfigId === 'number') {
            result = await db.execute(`
            SELECT c.id, c.name, s.player_id, c.player_count, c.team_count, p.current_nick FROM pickup_configs c
            LEFT JOIN state_pickup_players s ON s.pickup_config_id = c.id
            LEFT JOIN players p on p.user_id = s.player_id AND p.guild_id = s.guild_id
            WHERE c.guild_id = ? AND c.id = ?;
            `, [guildId, nameOrConfigId]);
        } else {
            result = await db.execute(`
            SELECT c.id, c.name, s.player_id, c.player_count, c.team_count, p.current_nick FROM pickup_configs c
            LEFT JOIN state_pickup_players s ON s.pickup_config_id = c.id
            LEFT JOIN players p on p.user_id = s.player_id AND p.guild_id = s.guild_id
            WHERE c.guild_id = ? AND c.name = ?;
            `, [guildId, nameOrConfigId]);
        }

        if (!result[0].length) {
            return;
        }

        const players = [];

        for (const row of result[0]) {
            players.push({
                id: row.player_id.toString(),
                nick: row.current_nick
            });
        }

        return {
            name: result[0][0].name,
            players,
            maxPlayers: result[0][0].player_count,
            teams: result[0][0].team_count,
            configId: result[0][0].id
        }
    }

    static async getActivePickups(guildId: bigint, includingDefaults = false): Promise<Map<string,
        { name: string, players: { id: string | null, nick: string | null }[]; maxPlayers: number; configId: number }>> {
        let result;

        if (!includingDefaults) {
            result = await db.execute(`
            SELECT c.guild_id, c.id, c.name, player_id, c.player_count, p.current_nick FROM state_pickup_players spp
            JOIN pickup_configs c ON spp.pickup_config_id = c.id
            JOIN players p ON p.user_id = spp.player_id AND p.guild_id = spp.guild_id 
            WHERE spp.guild_id = ?
            `, [guildId]);
        } else {
            result = await db.execute(`
			SELECT c.guild_id, c.id, c.name, s.player_id, c.player_count, p.current_nick FROM pickup_configs c
            LEFT JOIN state_pickup_players s ON s.pickup_config_id = c.id AND s.guild_id = c.guild_id
            LEFT JOIN players p on p.user_id = s.player_id AND p.guild_id = c.guild_id
            WHERE c.guild_id = ? AND (s.player_id IS NOT NULL OR c.is_default_pickup = true)
            `, [guildId]);
        }
        const pickups = new Map();

        for (const row of result[0]) {
            if (!pickups.has(row.name)) {
                pickups.set(row.name, { name: row.name, players: [{ id: row.player_id ? row.player_id.toString() : null, nick: row.current_nick }], maxPlayers: row.player_count, configId: row.id });
                continue;
            }
            pickups.get(row.name).players.push({ id: row.player_id ? row.player_id.toString() : null, nick: row.current_nick });
        }

        return pickups;
    }

    static async getAllPickups(guildId: bigint):
        Promise<{ id: number, name: string, added: number, max: number }[]> {
        const results: any = await db.execute(`
        SELECT pc.id, pc.name, COUNT(sp.player_id) as added, pc.player_count FROM state_pickup_players sp
        RIGHT JOIN pickup_configs pc ON sp.pickup_config_id = pc.id
        WHERE pc.guild_id = ?
        GROUP BY pc.id ORDER BY added DESC, pc.player_count DESC;
        `, [guildId]);

        const pickups = [];

        results[0].forEach(row => {
            pickups.push({
                id: row.id,
                name: row.name,
                added: row.added,
                max: row.player_count
            });
        });

        return pickups;
    }

    static async getAddedPlayers() {
        const players: any = await db.query(`
        SELECT player_id, guild_id FROM state_pickup_players
        `);

        if (!players[0].length) {
            return [];
        }

        return players[0].map(player => {
            return {
                player_id: player.player_id.toString(),
                guild_id: player.guild_id.toString()
            }
        })
    }

    static async getStoredPickupCount(guildId: bigint) {
        const count = await db.execute(`
        SELECT COUNT(*) AS cnt FROM pickup_configs
        WHERE guild_id = ?
        `, [guildId]);

        return count[0][0].cnt;
    }

    static async isPlayerAdded(guildId: bigint, playerId: bigint, ...pickupConfigIds): Promise<number[]> {
        if (pickupConfigIds.length === 0) {
            const result: any = await db.execute(`
            SELECT pickup_config_id FROM state_pickup_players
            WHERE guild_id = ? AND player_id = ?
            `, [guildId, playerId]);
            return result[0].map(row => row.pickup_config_id);
        }
        const result: any = await db.execute(`
        SELECT pickup_config_id FROM state_pickup_players
        WHERE guild_id = ? AND player_id = ?
        AND pickup_config_id IN (${Array(pickupConfigIds.length).fill('?').join(',')})
        `, [guildId, playerId, ...pickupConfigIds]);

        return result[0].map(row => row.pickup_config_id);
    }

    static async addPlayer(guildId: bigint, playerId: bigint, ...pickupConfigIds) {
        let valueStrings2 = [];
        let pickups = [];

        pickupConfigIds.forEach(id => {
            valueStrings2.push(`(${guildId}, ${playerId}, ${id})`)
            pickups.push(`(${guildId}, ${id})`);
        });

        // Update state pickup
        await db.query(`
        INSERT IGNORE INTO state_pickup (guild_id, pickup_config_id)
        VALUES ${pickups.join(', ')}
        `);

        // Insert pickup player
        await db.query(`
        INSERT state_pickup_players
        VALUES ${valueStrings2.join(', ')}
        `);
        return;
    }

    static async removePlayers(guildId: bigint, ...playerIds) {
        await transaction(db, async (db) => {
            await db.execute(`
            DELETE FROM state_pickup_players
            WHERE guild_id = ?
            AND player_id IN (${Array(playerIds.length).fill('?').join(',')})
            `, [guildId, ...playerIds]);

            await db.execute(`
            DELETE FROM state_pickup
            WHERE pickup_config_id NOT IN (SELECT DISTINCT pickup_config_id FROM state_pickup_players WHERE guild_id = ?)
            AND guild_id = ?
            `, [guildId, guildId]);
        });
    }

    static async clearPickupPlayers(guildId: bigint, pickupConfigId: number, connection?: PoolConnection) {
        const conn = connection || db;

        await transaction(conn, async (db) => {
            // Remove players
            await db.execute(`
            DELETE FROM state_pickup_players
            WHERE guild_id = ? AND pickup_config_id = ?
            `, [guildId, pickupConfigId]);

            // Remove pickup
            await db.execute(`
            DELETE FROM state_pickup
            WHERE guild_id = ? AND pickup_config_id = ?
            `, [guildId, pickupConfigId]);
        });
    }

    static async removePlayersExclude(guildId: bigint, excludedPickups: number[], ...playerIds) {
        await db.execute(`
        DELETE FROM state_pickup_players
        WHERE guild_id = ?
        AND player_id IN (${Array(playerIds.length).fill('?').join(',')})
        AND pickup_config_id NOT IN (${Array(excludedPickups.length).fill('?').join(',')})
        `, [guildId, ...playerIds, ...excludedPickups]);

        await db.execute(`
        DELETE FROM state_pickup
        WHERE pickup_config_id NOT IN (SELECT DISTINCT pickup_config_id FROM state_pickup_players WHERE guild_id = ?)
        AND guild_id = ?
        `, [guildId, guildId]);
    }

    static async removePlayer(connection: PoolConnection | null = null, guildId: bigint, playerId: bigint, ...pickupConfigIds) {
        const conn = connection || db;

        try {
            if (pickupConfigIds.length === 0) {
                await conn.execute(`
                DELETE FROM state_pickup_players
                WHERE guild_id = ? AND player_id = ?
                `, [guildId, playerId]);
            } else {
                await conn.execute(`
                DELETE FROM state_pickup_players
                WHERE guild_id = ? AND player_id = ?
                AND pickup_config_id IN (${Array(pickupConfigIds.length).fill('?').join(',')})
                `, [guildId, playerId, ...pickupConfigIds]);
            }

            // Maybe need to find a better solution for this
            await conn.execute(`
            DELETE FROM state_pickup
            WHERE pickup_config_id NOT IN (SELECT DISTINCT pickup_config_id FROM state_pickup_players WHERE guild_id = ?)
            AND guild_id = ?
            `, [guildId, guildId]);
        } catch (e) {
            throw e;
        }
    }

    static async updatePlayerAddTime(guildId: bigint, playerId: bigint) {
        await db.execute(`
        INSERT INTO state_guild_player (guild_id, player_id, last_add)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE last_add = CURRENT_TIMESTAMP
        `, [guildId, playerId]);
        return;
    }

    static async getPickupSettings(guildId: BigInt, pickup: number | string): Promise<PickupSettings> {
        let settings;

        if (typeof pickup === 'number') {
            settings = await db.execute(`
            SELECT * FROM pickup_configs
            WHERE guild_id = ? AND id  = ?
            `, [guildId, pickup]);
        } else {
            settings = await db.execute(`
            SELECT * FROM pickup_configs
            WHERE guild_id = ? AND name = ?
            `, [guildId, pickup]);
        }

        settings = settings[0][0];

        return {
            id: settings.id,
            name: settings.name,
            playerCount: settings.player_count,
            teamCount: settings.team_count,
            isDefaultPickup: Boolean(settings.is_default_pickup),
            mapPoolId: settings.mappool_id ? settings.mappool_id : null,
            afkCheck: Boolean(settings.afk_check),
            pickMode: settings.pick_mode,
            whitelistRole: settings.whitelist_role ? settings.whitelist_role.toString() : null,
            blacklistRole: settings.blacklist_role ? settings.blacklist_role.toString() : null,
            promotionRole: settings.promotion_role ? settings.promotion_role.toString() : null,
            captainRole: settings.captain_role ? settings.captain_role.toString() : null,
            serverId: settings.server_id ? settings.server_id : null
        }
    }

    static async getMultiplePickupSettings(guildId: BigInt, ...pickups): Promise<PickupSettings[]> {
        let settings;

        if (typeof pickups[0] === 'number') {
            settings = await db.execute(`
            SELECT * FROM pickup_configs
            WHERE guild_id = ? AND id IN (${Array(pickups.length).fill('?').join(',')})
            `, [guildId, ...pickups]);
        } else {
            settings = await db.execute(`
            SELECT * FROM pickup_configs
            WHERE guild_id = ? AND name IN (${Array(pickups.length).fill('?').join(',')})
            `, [guildId, ...pickups]);
        }

        settings = settings[0];

        const results = [];

        settings.forEach(settings => results.push({
            id: settings.id,
            name: settings.name,
            playerCount: settings.player_count,
            teamCount: settings.team_count,
            isDefaultPickup: Boolean(settings.is_default_pickup),
            mapPoolId: settings.mappool_id ? settings.mappool_id : null,
            afkCheck: Boolean(settings.afk_check),
            pickMode: settings.pick_mode,
            whitelistRole: settings.whitelist_role ? settings.whitelist_role.toString() : null,
            blacklistRole: settings.blacklist_role ? settings.blacklist_role.toString() : null,
            promotionRole: settings.promotion_role ? settings.promotion_role.toString() : null,
            captainRole: settings.captain_role ? settings.captain_role.toString() : null,
            serverId: settings.server_id ? settings.server_id : null
        }));

        return results;
    }

    static async modifyPickup(guildId: bigint, pickup: number | string, key: string, value: string) {
        let newValue: string | number = value;

        if (value === 'true') {
            newValue = 1;
        } else if (value === 'false') {
            newValue = 0;
        }

        if (typeof pickup === 'number') {
            await db.execute(`
            UPDATE pickup_configs SET ${key} = ?
            WHERE guild_id = ? AND id = ?
            `, [newValue, guildId, pickup]);
        } else {
            await db.execute(`
            UPDATE pickup_configs SET ${key} = ?
            WHERE guild_id = ? AND name = ?
            `, [newValue, guildId, pickup]);
        }
    }

    static async setPending(guildId: bigint, pickupConfigId: number, stage: 'afk_check' | 'picking_manual' | 'fill', connection?: PoolConnection) {
        const conn = connection || db;

        await conn.execute(`
        UPDATE state_pickup SET stage = ?, in_stage_since = CURRENT_TIMESTAMP, stage_iteration = 0
        WHERE guild_id = ? AND pickup_config_id = ?
        `, [stage, guildId, pickupConfigId]);
    }

    static async setPendings(guildId: bigint, stage: 'afk_check' | 'picking_manual' | 'fill', ...pickupConfigIds) {
        await db.execute(`
        UPDATE state_pickup SET stage = ?, in_stage_since = CURRENT_TIMESTAMP, stage_iteration = 0
        WHERE guild_id = ? AND pickup_config_id IN (${Array(pickupConfigIds.length).fill('?').join(',')})
        `, [stage, guildId, ...pickupConfigIds]);
    }

    static async incrementPendingIteration(guildId: BigInt, pickupConfigId: number) {
        await db.execute(`
        UPDATE state_pickup SET stage_iteration = stage_iteration + 1
        WHERE guild_id = ? AND pickup_config_id = ?
        `, [guildId, pickupConfigId]);
    }

    static async resetPendingIteration(guildId: BigInt, pickupConfigId: number) {
        await db.execute(`
        UPDATE state_pickup SET stage_iteration = 0
        WHERE guild_id = ? AND pickup_config_id = ?
        `, [guildId, pickupConfigId]);
    }

    static async isInStage(guildId: bigint, pickupConfigId: number, stage: 'afk_check' | 'picking_manual' | 'fill') {
        const inStage = await db.execute(`
        SELECT COUNT(*) as pending FROM state_pickup
        WHERE guild_id = ? AND pickup_config_id = ? AND stage = ?
        `, [guildId, pickupConfigId, stage]);

        return inStage[0][0].pending;
    }

    static async playedBefore(guildId: bigint, playerId: BigInt):
        Promise<boolean> {
        const playedBefore: any = await db.execute(`
        SELECT 1 as played FROM pickup_players pp
        JOIN players ps ON pp.player_id = ps.id
        WHERE ps.guild_id = ? AND ps.user_id = ?
        LIMIT 1
        `, [guildId, playerId]);

        if (!playedBefore[0].length) {
            return false;
        } else {
            return true;
        }
    }

    static async addTeamPlayers(guildId: bigint, pickupConfigId: number,
        ...players: { id: bigint, team: string, isCaptain: boolean, captainTurn: boolean }[]) {
        const toInsert = [];

        players.forEach(player => {
            toInsert.push(guildId, pickupConfigId, player.id, player.team, +player.isCaptain, +player.captainTurn);
        });

        await db.execute(`
        INSERT INTO state_teams VALUES ${Array(toInsert.length / 6).fill('(?, ?, ?, ?, ?, ?)').join(',')}
        `, toInsert);
    }

    static async clearTeams(guildId: bigint, pickupConfigId: number, connection?: PoolConnection) {
        const conn = connection || db;

        await conn.execute(`
        DELETE FROM state_teams WHERE guild_id = ? AND pickup_config_id = ?
        `, [guildId, pickupConfigId]);
    }

    static async isPlayerAddedToPendingPickup(guildId: bigint, playerId: bigint, stage: 'fill' | 'afk_check' | 'picking_manual'):
        Promise<boolean> {
        const data: any = await db.execute(`
        SELECT * FROM state_pickup sp
        JOIN state_pickup_players spp ON sp.pickup_config_id = spp.pickup_config_id
        WHERE sp.stage = ? AND sp.guild_id = ? AND spp.player_id = ?
        LIMIT 1
        `, [stage, guildId, playerId]);

        if (!data[0].length) {
            return false;
        }

        return true;
    }

    static async setNewCaptainTurn(guildId: bigint, pickupConfigId: number, team: string, connection?: PoolConnection) {
        await transaction(connection || db, async (db) => {
            await db.execute(`
            UPDATE state_teams SET captain_turn = 0
            WHERE guild_id = ? AND pickup_config_id = ? AND captain_turn = 1
            `, [guildId, pickupConfigId]);

            await db.execute(`
            UPDATE state_teams SET captain_turn = 1
            WHERE guild_id = ? AND pickup_config_id = ? AND team = ? AND is_captain = 1
            `, [guildId, pickupConfigId, team]);
        });
    }

    // Used when a sql error occurs or transaction fails
    static async resetPickup(guildId: bigint, pickupConfigId: number) {
        await transaction(db, async (conn) => {
            const db = conn as PoolConnection;

            await this.clearPickupPlayers(guildId, pickupConfigId, db);

            // Clear player states if necessary
            await db.execute(`
            UPDATE state_guild_player
            SET pickup_expire = null, last_add = null, is_afk = null
            WHERE guild_id = ? 
            AND player_id NOT IN (SELECT DISTINCT player_id FROM state_pickup_players WHERE guild_id = ?)
            `, [guildId, guildId]);

            // Clear teams
            await this.clearTeams(guildId, pickupConfigId, db);
        });
    }

    static async abortPendingPickingPickup(guildId: bigint, pickupConfigId: number, playerId: bigint) {
        await transaction(db, async (conn) => {
            const c = conn as PoolConnection;
            await this.setPending(guildId, pickupConfigId, 'fill', c);
            await this.clearTeams(guildId, pickupConfigId, c);
            await this.removePlayer(c, guildId, playerId, pickupConfigId);
        });
    }

    static async abortAfkCheck(guildId: bigint, pickupConfigId: number) {
        await transaction(db, async (conn) => {
            const c = conn as PoolConnection;

            await PickupModel.setPending(guildId, pickupConfigId, 'fill', c);
        })
    }
}