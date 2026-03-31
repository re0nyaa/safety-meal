import axios from "axios"
import {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    InteractionType,
} from "discord.js"
import { REST, Routes } from "discord.js"

import dotenv from "dotenv"
import cron from "node-cron"

dotenv.config()

const NEIS_API_URL = "https://open.neis.go.kr/hub/mealServiceDietInfo"
const USER_ALLERGIES = new Set(["14"])

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN
const DISCORD_USER_ID =
    process.env.DISCORD_DM_USER_ID ?? process.env.DISCORD_USER_ID

const TIME_ZONE = "Asia/Seoul"

const SCHEDULES = [
    { cron: "50 6 * * *", mealTime: "조식" },
    { cron: "0 12 * * *", mealTime: "중식" },
    { cron: "0 18 * * *", mealTime: "석식" },
] as const

function getDateInfo(offset = 0) {
    const now = new Date()

    const kst = new Date(now.toLocaleString("en-US", { timeZone: TIME_ZONE }))

    kst.setDate(kst.getDate() + offset)

    const yyyy = kst.getFullYear()
    const mm = String(kst.getMonth() + 1).padStart(2, "0")
    const dd = String(kst.getDate()).padStart(2, "0")

    return {
        yyyy: String(yyyy),
        mm,
        dd,
        dateStr: `${yyyy}${mm}${dd}`,
    }
}

function normalizeAllergyDisplay(menu: string): string {
    return menu.replace(/\(([^)]+)\)/g, (fullMatch, inner) => {
        const matched = inner
            .split(".")
            .map((t: string) => t.trim())
            .filter((t: string) => USER_ALLERGIES.has(t))

        if (matched.length === 0) return ""
        return `(${matched.join(".")})`
    })
}

function hasUserAllergy(menu: string): boolean {
    const matches = menu.match(/\(([^)]+)\)/g)
    if (!matches) return false

    for (const block of matches) {
        const tokens = block
            .replace(/[()]/g, "")
            .split(".")
            .map((t) => t.trim())

        if (tokens.some((t) => USER_ALLERGIES.has(t))) return true
    }

    return false
}

function validateEnvironment() {
    if (!process.env.NEIS_OPEN_KEY) throw new Error("NEIS_OPEN_KEY 필요")
    if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN 필요")
    if (!DISCORD_USER_ID) throw new Error("DISCORD_USER_ID 필요")
}

async function getGroupedMealMenus(dateStr: string) {
    const response = await axios.get(NEIS_API_URL, {
        params: {
            KEY: process.env.NEIS_OPEN_KEY,
            Type: "json",
            pIndex: 1,
            pSize: 100,
            ATPT_OFCDC_SC_CODE: "R10",
            SD_SCHUL_CODE: "8750829",
            MLSV_FROM_YMD: dateStr,
            MLSV_TO_YMD: dateStr,
        },
    })

    const data = response.data.mealServiceDietInfo
    if (!(data && data[1] && data[1].row)) return null

    const meals = data[1].row
    const grouped: Record<string, string[]> = {}

    meals.forEach((meal: any) => {
        const key = meal.MMEAL_SC_NM
        if (!grouped[key]) grouped[key] = []

        const menus = String(meal.DDISH_NM)
            .split(/<br\/?\s*>/i)
            .map((m) => m.trim())
            .filter((m) => m.length > 0)

        grouped[key].push(...menus)
    })

    return grouped
}

async function getAllMealMenus(mealTime: string, offset = 0) {
    const { dateStr } = getDateInfo(offset)
    const grouped = await getGroupedMealMenus(dateStr)
    if (!grouped) return []

    return grouped[mealTime]?.map((m) => m.replace(/\s+/g, " ").trim()) ?? []
}

async function buildMealEmbed(mealTime: string, offset = 0) {
    const { yyyy, mm, dd } = getDateInfo(offset)
    const menus = await getAllMealMenus(mealTime, offset)

    const description = menus.length === 0 ? "급식 정보 없음" : menus.join("\n")

    return new EmbedBuilder()
        .setTitle(`${yyyy}-${mm}-${dd} ${mealTime}`)
        .setDescription(description)
        .setFooter({
            text: `알레르기: ${[...USER_ALLERGIES].join(", ")}`,
        })
}

function mealButtons(offset: number) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`meal_breakfast_${offset}`)
            .setLabel("조식")
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId(`meal_lunch_${offset}`)
            .setLabel("중식")
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId(`meal_dinner_${offset}`)
            .setLabel("석식")
            .setStyle(ButtonStyle.Secondary),
    )
}

async function sendDm(client: Client, content: string) {
    const user = await client.users.fetch(DISCORD_USER_ID!)
    await user.send(content)
}

async function buildMealMessage(mealTime: string) {
    const { yyyy, mm, dd, dateStr } = getDateInfo(0)
    const grouped = await getGroupedMealMenus(dateStr)

    if (!grouped) return "급식 정보 없음"

    const filtered = grouped[mealTime]
        ?.filter((m) => hasUserAllergy(m))
        .map((m) => normalizeAllergyDisplay(m))

    if (!filtered || filtered.length === 0)
        return `${yyyy}-${mm}-${dd} ${mealTime} 알레르기 메뉴 없음`

    return [`${yyyy}-${mm}-${dd} ${mealTime}`, ...filtered].join("\n")
}

async function sendScheduledMeal(client: Client, mealTime: string) {
    try {
        const msg = await buildMealMessage(mealTime)
        await sendDm(client, msg)
    } catch {}
}

function registerSchedules(client: Client) {
    for (const s of SCHEDULES) {
        cron.schedule(
            s.cron,
            () => {
                void sendScheduledMeal(client, s.mealTime)
            },
            { timezone: TIME_ZONE },
        )
    }
}

const commands = [
    { name: "급식", description: "오늘 급식" },
    { name: "내일급식", description: "내일 급식" },
]

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN!)

async function main() {
    validateEnvironment()

    const client = new Client({ intents: [GatewayIntentBits.Guilds] })

    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), {
        body: commands,
    })

    client.once("ready", () => {
        registerSchedules(client)
    })

    client.on("interactionCreate", async (interaction) => {
        if (
            interaction.type !== InteractionType.ApplicationCommand &&
            !interaction.isButton()
        )
            return

        if (interaction.isChatInputCommand()) {
            let offset = 0

            if (interaction.commandName === "내일급식") offset = 1

            const embed = await buildMealEmbed("조식", offset)

            await interaction.reply({
                embeds: [embed],
                components: [mealButtons(offset)],
            })
        }

        if (interaction.isButton()) {
            const [_, mealKey, offsetStr] = interaction.customId.split("_")

            const mealMap: any = {
                breakfast: "조식",
                lunch: "중식",
                dinner: "석식",
            }

            if (!mealKey || !offsetStr) return

            const meal = mealMap[mealKey]
            const offset = Number(offsetStr)

            const embed = await buildMealEmbed(meal, offset)

            await interaction.update({
                embeds: [embed],
                components: [mealButtons(offset)],
            })
        }
    })

    await client.login(DISCORD_TOKEN)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
