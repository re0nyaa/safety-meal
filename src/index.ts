import axios from "axios"
import { Client, GatewayIntentBits } from "discord.js"
import dotenv from "dotenv"
import cron from "node-cron"

dotenv.config()

const NEIS_API_URL = "https://open.neis.go.kr/hub/mealServiceDietInfo"
const USER_ALLERGIES = new Set(["18", "14", "9", "4"])
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN
const DISCORD_USER_ID =
    process.env.DISCORD_DM_USER_ID ?? process.env.DISCORD_USER_ID
const TIME_ZONE = "Asia/Seoul"
const SCHEDULES = [
    { cron: "50 6 * * *", mealTime: "조식" },
    { cron: "0 12 * * *", mealTime: "중식" },
    { cron: "0 18 * * *", mealTime: "석식" },
] as const

function getTodayInfo() {
    const today = new Date()

    return {
        yyyy: String(today.getFullYear()),
        mm: String(today.getMonth() + 1).padStart(2, "0"),
        dd: String(today.getDate()).padStart(2, "0"),
        todayStr: `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`,
    }
}

function normalizeAllergyDisplay(menu: string): string {
    return menu.replace(/\(([^)]+)\)/g, (fullMatch, inner) => {
        const matched = inner
            .split(".")
            .map((token: string) => token.trim())
            .filter((token: string) => USER_ALLERGIES.has(token))

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
            .map((token) => token.trim())

        if (tokens.some((token) => USER_ALLERGIES.has(token))) {
            return true
        }
    }

    return false
}

function validateEnvironment() {
    if (!process.env.NEIS_OPEN_KEY) {
        throw new Error("NEIS_OPEN_KEY 환경변수가 필요합니다.")
    }

    if (!DISCORD_TOKEN) {
        throw new Error(
            "DISCORD_BOT_TOKEN 또는 DISCORD_TOKEN 환경변수가 필요합니다.",
        )
    }

    if (!DISCORD_USER_ID) {
        throw new Error(
            "DISCORD_DM_USER_ID 또는 DISCORD_USER_ID 환경변수가 필요합니다.",
        )
    }
}

async function getGroupedMealMenus() {
    const { todayStr } = getTodayInfo()

    const response = await axios.get(NEIS_API_URL, {
        params: {
            KEY: process.env.NEIS_OPEN_KEY,
            Type: "json",
            pIndex: 1,
            pSize: 100,
            ATPT_OFCDC_SC_CODE: "R10",
            SD_SCHUL_CODE: "8750829",
            MLSV_FROM_YMD: todayStr,
            MLSV_TO_YMD: todayStr,
        },
    })

    const data = response.data.mealServiceDietInfo
    if (!(data && data[1] && data[1].row)) {
        return null
    }

    const meals = data[1].row
    const grouped: Record<string, string[]> = {}

    meals.forEach((meal: any) => {
        const key = meal.MMEAL_SC_NM
        if (!grouped[key]) grouped[key] = []

        const menus = String(meal.DDISH_NM)
            .split(/<br\/?\s*>/i)
            .map((menu) => menu.trim())
            .filter((menu) => menu.length > 0)

        grouped[key].push(...menus)
    })

    return grouped
}

async function buildMealMessage(mealTime: string) {
    const { yyyy, mm, dd } = getTodayInfo()
    const grouped = await getGroupedMealMenus()

    if (!grouped) {
        return `오늘(${yyyy}-${mm}-${dd}) 급식 정보가 없습니다.`
    }

    const filteredMenus = grouped[mealTime]
        ?.filter((menu) => hasUserAllergy(menu))
        .map((menu) =>
            normalizeAllergyDisplay(menu).replace(/\s+/g, " ").trim(),
        )

    if (!filteredMenus || filteredMenus.length === 0) {
        return `오늘(${yyyy}-${mm}-${dd}) ${mealTime}에는 선택한 알레르기(${[...USER_ALLERGIES].join(", ")})가 포함된 메뉴가 없습니다.`
    }

    return [
        `오늘(${yyyy}-${mm}-${dd}) ${mealTime} 알레르기 포함 급식`,
        `대상 알레르기: ${[...USER_ALLERGIES].join(", ")}`,
        "",
        mealTime,
        ...filteredMenus,
    ]
        .join("\n")
        .trim()
}

async function sendDm(client: Client, content: string) {
    const user = await client.users.fetch(DISCORD_USER_ID!)
    await user.send(content)
}

async function sendScheduledMeal(client: Client, mealTime: string) {
    try {
        const message = await buildMealMessage(mealTime)
        await sendDm(client, message)
    } catch (error) {}
}

function registerSchedules(client: Client) {
    for (const schedule of SCHEDULES) {
        cron.schedule(
            schedule.cron,
            () => {
                void sendScheduledMeal(client, schedule.mealTime)
            },
            { timezone: TIME_ZONE },
        )
    }
}

async function main() {
    validateEnvironment()

    const client = new Client({ intents: [GatewayIntentBits.Guilds] })

    client.once("ready", () => {
        registerSchedules(client)
    })

    await client.login(DISCORD_TOKEN)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
