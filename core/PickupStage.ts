import Discord, { GuildMember } from 'discord.js';
import PickupModel from "../models/pickup";
import PickupState from './pickupState';
import Util from './util';
import GuildModel from '../models/guild';
import StatsModel from '../models/stats';
import afkCheckStage from './stages/afkCheck';
import { manualPicking } from './stages/manualPicking';
import { PickupSettings } from './types';
import Bot from './bot';

export default class PickupStage {
    private constructor() { }

    static async handle(guild: Discord.Guild, pickupConfigId: number) {
        const pickupSettings = await PickupModel.getPickupSettings(BigInt(guild.id), pickupConfigId);
        const pickupChannel = await Util.getPickupChannel(guild);

        // Afk check
        if (pickupSettings.afkCheck) {
            await PickupModel.setPending(BigInt(guild.id), pickupConfigId, 'afk_check');

            try {
                return await afkCheckStage(guild, pickupConfigId, true);
            } catch (_err) {
                const pickup = await PickupModel.getActivePickup(BigInt(guild.id), pickupConfigId);
                const players = pickup.players.map(player => player.id);

                await GuildModel.removeAfks(BigInt(guild.id), ...players);

                if (pickupChannel) {
                    pickupChannel.send(`afk check failed, attempting to progress to the next stage for **pickup ${pickup.name}** without checking`);
                }
            }
        }

        this.handleStart(guild, pickupSettings, pickupChannel);
    }

    static async handleStart(guild: Discord.Guild, pickupSettings: PickupSettings, pickupChannel: Discord.TextChannel) {
        switch (pickupSettings.pickMode) {
            case 'no_teams':
                try {
                    await this.startPickup(guild, pickupSettings.id);
                } catch (_err) {
                    await PickupModel.resetPickup(BigInt(guild.id), pickupSettings.id);

                    if (pickupChannel) {
                        pickupChannel.send(`something went wrong starting the pickup, **pickup ${pickupSettings.name}** cleared`);
                    }
                }
                break;
            case 'manual':
                try {
                    await PickupModel.setPending(BigInt(guild.id), pickupSettings.id, 'picking_manual');
                    await manualPicking(guild, pickupSettings.id, true);
                } catch (_err) {
                    // Still attempt to start without teams
                    try {
                        Bot.getInstance().getGuild(guild.id).pendingPickups.delete(pickupSettings.id);

                        if (pickupChannel) {
                            pickupChannel.send(`something went wrong with **pickup ${pickupSettings.name}** in picking phase, attempting to start without teams`);
                        }

                        await PickupModel.clearTeams(BigInt(guild.id), pickupSettings.id);
                        await this.startPickup(guild, pickupSettings.id)
                    } catch (_err) {
                        await PickupModel.resetPickup(BigInt(guild.id), pickupSettings.id);

                        if (pickupChannel) {
                            pickupChannel.send(`something went wrong starting **pickup ${pickupSettings.name}** without teams, pickup cleared`);
                        }
                    }
                }
                break;
            case 'elo':
            // TODO: Generate teams and call startPickup with generated teams
        }
    }

    static async startPickup(guild: Discord.Guild, pickupConfigId: number, teams?: bigint[][], captains?: bigint[]) {
        const aboutToStart = Array.from(await (await PickupModel.getActivePickups(BigInt(guild.id), false)).values())
            .find(pickup => pickup.configId === pickupConfigId);

        const addedPlayers = aboutToStart.players.map(player => player.id);

        let players;

        if (teams) {
            players = teams;
        } else {
            players = addedPlayers;
        }

        // Remove players
        await PickupState.removePlayers(guild.id, true, pickupConfigId, ...addedPlayers);

        // Get & parse start message and display that
        const pickupSettings = await PickupModel.getPickupSettings(BigInt(guild.id), +aboutToStart.configId);
        const guildSettings = await GuildModel.getGuildSettings(guild);

        const startMessage = await Util.parseStartMessage(BigInt(guild.id), guildSettings.startMessage, pickupSettings, players);

        if (startMessage.length) {
            const pickupChannel = await Util.getPickupChannel(guild);
            await pickupChannel.send(startMessage);
            await PickupState.showPickupStatus(guild);
        }

        // DM players with enabled notifications
        const playersToDm = await GuildModel.getPlayersWithNotify(BigInt(guild.id), ...addedPlayers);

        if (playersToDm.length) {
            const dmMessage = await Util.parseNotifySubMessage(BigInt(guild.id), guildSettings.notifyMessage, pickupSettings);

            if (dmMessage.length) {
                for (const playerId of playersToDm) {
                    const member = guild.members.cache.get(playerId);
                    if (member) {
                        await member.send(dmMessage);
                    }
                }
            }
        }

        try {
            await StatsModel.storePickup(BigInt(guild.id), pickupConfigId, players, captains);
        } catch (_err) {
            const pickupChannel = await Util.getPickupChannel(guild);

            if (pickupChannel) {
                pickupChannel.send(`something went wrong storing the **${aboutToStart.name}** pickup, pickup not stored`);
            }
        }
    }
}