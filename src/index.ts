import axios from "axios"
import express from "express"
import fs from "fs/promises"
import path from "path"
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

const CACHE_DIR = path.resolve(process.cwd(), ".cache")
const CACHE_TTL_MS = 1000 * 60 * 30 // 30분

async function readCache(filePath: string) {
    try {
        const stat = await fs.stat(filePath)
        if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null

        const raw = await fs.readFile(filePath, "utf-8")
        return JSON.parse(raw)
    } catch {
        return null
    }
}

async function writeCache(filePath: string, data: unknown) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(data), "utf-8")
}

const SCHEDULES = [
    { cron: "50 6 * * *", mealTime: "조식" },
    { cron: "0 12 * * *", mealTime: "중식" },
    { cron: "0 18 * * *", mealTime: "석식" },
] as const

function getKstDate(source?: Date) {
    const base = source ? source : new Date()
    return new Date(base.toLocaleString("en-US", { timeZone: TIME_ZONE }))
}

function formatDate(date: Date) {
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, "0")
    const dd = String(date.getDate()).padStart(2, "0")

    return {
        yyyy: String(yyyy),
        mm,
        dd,
        dateStr: `${yyyy}${mm}${dd}`,
    }
}

function getDateInfo(offset = 0) {
    const kst = getKstDate()
    kst.setDate(kst.getDate() + offset)
    return formatDate(kst)
}

function getDateInfoFromDate(date: Date) {
    const kst = getKstDate(date)
    return formatDate(kst)
}

function toDateQuery(date: Date) {
    const { yyyy, mm, dd } = formatDate(getKstDate(date))
    return `${yyyy}-${mm}-${dd}`
}

function parseDateQuery(dateParam?: string) {
    if (!dateParam) return getKstDate()

    const clean = dateParam.trim()
    let yyyy: number, mm: number, dd: number

    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(clean)) {
        const parts = clean.split("-")
        if (parts.length !== 3) return getKstDate()
        yyyy = Number(parts[0])
        mm = Number(parts[1])
        dd = Number(parts[2])
    } else {
        const cleaned = clean.replace(/[^0-9]/g, "")
        if (!/^[0-9]{8}$/.test(cleaned)) return getKstDate()

        yyyy = Number(cleaned.slice(0, 4))
        mm = Number(cleaned.slice(4, 6))
        dd = Number(cleaned.slice(6, 8))
    }

    const date = new Date(Date.UTC(yyyy, mm - 1, dd))
    if (isNaN(date.getTime())) return getKstDate()

    return getKstDate(date)
}

function toDateId(date: Date) {
    const { yyyy, mm, dd } = formatDate(getKstDate(date))
    return `${yyyy}${mm}${dd}`
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
    if (!/^[0-9]{8}$/.test(dateStr)) return null

    const year = Number(dateStr.slice(0, 4))
    const month = Number(dateStr.slice(4, 6))
    const monthly = await getMonthlyMealMenus(year, month)
    if (!monthly) return null

    return monthly[dateStr] ?? null
}

async function getMonthlyMealMenus(year: number, month: number) {
    const cacheFile = path.join(
        CACHE_DIR,
        `month-${year}-${String(month).padStart(2, "0")}.json`,
    )
    const cached = (await readCache(cacheFile)) as Record<
        string,
        Record<string, string[]>
    > | null
    if (cached !== null) return cached

    const firstDay = 1
    const lastDay = new Date(year, month, 0).getDate()

    const from = `${year}${String(month).padStart(2, "0")}${String(firstDay).padStart(2, "0")}`
    const to = `${year}${String(month).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`

    const response = await axios.get(NEIS_API_URL, {
        params: {
            KEY: process.env.NEIS_OPEN_KEY,
            Type: "json",
            pIndex: 1,
            pSize: 100,
            ATPT_OFCDC_SC_CODE: "R10",
            SD_SCHUL_CODE: "8750829",
            MLSV_FROM_YMD: from,
            MLSV_TO_YMD: to,
        },
    })

    const data = response.data.mealServiceDietInfo
    if (!(data && data[1] && data[1].row)) return {}

    const meals = data[1].row
    const monthly: Record<string, Record<string, string[]>> = {}

    meals.forEach((meal: any) => {
        const dateKey = meal.MLSV_FROM_YMD || meal.MLSV_TO_YMD || ""
        if (!dateKey) return

        if (!monthly[dateKey]) monthly[dateKey] = {}
        const key = meal.MMEAL_SC_NM

        if (!monthly[dateKey][key]) monthly[dateKey][key] = []

        const menus = String(meal.DDISH_NM)
            .split(/<br\/?\s*>/i)
            .map((m) => m.trim())
            .filter((m) => m.length > 0)

        monthly[dateKey][key].push(...menus)
    })

    await writeCache(cacheFile, monthly)
    return monthly
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

    const app = express()

    app.get("/api/meal", async (req, res) => {
        try {
            const requestedDate = parseDateQuery(
                typeof req.query.date === "string" ? req.query.date : undefined,
            )
            const currentInfo = getDateInfoFromDate(requestedDate)
            const grouped = await getGroupedMealMenus(currentInfo.dateStr)
            const monthly = await getMonthlyMealMenus(
                Number(currentInfo.yyyy),
                Number(currentInfo.mm),
            )

            res.json({
                date: {
                    iso: `${currentInfo.yyyy}-${currentInfo.mm}-${currentInfo.dd}`,
                    id: currentInfo.dateStr,
                },
                meals: grouped ?? {},
                monthly,
            })
        } catch (error) {
            res.status(500).json({ error: String(error) })
        }
    })

    app.get("/", async (_req, res) => {
        res.send(`
<!doctype html>
<html lang="ko">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>급식표</title>
    <style>
        body { font-family: "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", sans-serif; background: #f4f5f8; color: #333; margin: 0; padding: 20px; }
        .container { max-width: 960px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 6px 18px rgba(0,0,0,0.08); padding: 24px; }
        h1, h2, h3 { color: #1f2937; }
        .nav { display: flex; justify-content: space-between; margin: 12px 0 20px; }
        .nav button { color: #fff; background: #2563eb; border: 0; padding: 8px 14px; border-radius: 8px; font-weight: 600; cursor: pointer; }
        .nav button:hover { background: #1d4ed8; }
        .meal-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; background: #fafafa; margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; }
        thead th { background: #f3f4f6; }
    </style>
</head>
<body>
    <div class="container">
        <h1 id="dateLabel">오늘 급식</h1>
        <div class="nav">
            <button id="prevBtn">◀ 이전날</button>
            <button id="nextBtn">다음날 ▶</button>
        </div>
        <div id="mealContent"></div>
        <h2 id="monthTitle"></h2>
        <table>
            <thead><tr><th>일</th><th>조식</th><th>중식</th><th>석식</th></tr></thead>
            <tbody id="monthlyBody"></tbody>
        </table>
    </div>

    <script>
        const DAY_ADD = 24*60*60*1000
        let currentDate = new Date()

        function formatId(date) {
            const y = date.getFullYear();
            const m = String(date.getMonth()+1).padStart(2,'0')
            const d = String(date.getDate()).padStart(2,'0')
            return y + '-' + m + '-' + d
        }

        function render(data) {
            document.getElementById('dateLabel').textContent = data.date.iso + ' 급식'

            const names = ['조식','중식','석식']
            const mealContent = names.map(function(name) {
                const items = data.meals[name] || []
                var content = '<div class="meal-card"><h3>' + name + '</h3><p>'
                if (items.length) {
                    content += items.join('<br>')
                } else {
                    content += '급식 정보 없음'
                }
                content += '</p></div>'
                return content
            }).join('')
            document.getElementById('mealContent').innerHTML = mealContent

            document.getElementById('monthTitle').textContent = data.date.iso.slice(0,7) + ' 월별 급식'
            var rows = []
            var daily = Object.keys(data.monthly).sort()
            daily.forEach(function(dateKey) {
                var day = Number(dateKey.slice(6,8))
                var row = data.monthly[dateKey]
                var rowCells = names.map(function(name) {
                    return (row[name] ? row[name].join('<br>') : '-')
                }).join('</td><td>')
                rows.push('<tr><td>' + day + '</td><td>' + rowCells + '</td></tr>')
            })
            document.getElementById('monthlyBody').innerHTML = rows.join('')
        }

        async function load(date) {
            const iso = formatId(date)
            const response = await fetch('/api/meal?date=' + iso)
            const data = await response.json()
            currentDate = date
            render(data)
        }

        document.getElementById('prevBtn').addEventListener('click', () => {
            const next = new Date(currentDate.valueOf() - DAY_ADD)
            load(next)
        })
        document.getElementById('nextBtn').addEventListener('click', () => {
            const next = new Date(currentDate.valueOf() + DAY_ADD)
            load(next)
        })

        load(currentDate)
    </script>
</body>
</html>
        `)
    })

    const webPort = Number(process.env.PORT ?? 3005)
    app.listen(webPort, () => {
        // eslint-disable-next-line no-console
        console.log(`Express server listening on http://localhost:${webPort}`)
    })

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

            const mealMap: Record<string, string> = {
                breakfast: "조식",
                lunch: "중식",
                dinner: "석식",
            }

            if (!mealKey || !offsetStr) return

            const meal = mealMap[mealKey]
            const offset = Number(offsetStr)
            if (!meal || Number.isNaN(offset)) {
                await interaction.reply({
                    content: "잘못된 버튼 정보입니다.",
                    ephemeral: true,
                })
                return
            }

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
