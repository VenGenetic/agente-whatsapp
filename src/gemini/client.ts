import { GoogleGenAI } from '@google/genai'
import { config } from '../config.js'

export const genai = new GoogleGenAI({ apiKey: config.geminiApiKey })
