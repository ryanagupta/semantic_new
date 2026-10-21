import { SignJWT, jwtVerify } from 'jose';
import type { RequestHandler } from 'express';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';

const key = new TextEncoder().encode(config.sessionSecret);
export const scraperIdentityHeader = 'x-relay-scraper-identity';
export async function signScraperIdentity(userId: string) {
  return new SignJWT({ purpose: 'scraper-management' }).setProtectedHeader({ alg: 'HS256' })
    .setIssuer('relay-portal').setAudience('relay-scraper').setSubject(userId).setIssuedAt().setExpirationTime('30s').sign(key);
}
export type ScraperRequest = import('express').Request & { scraperUserId: string };
export const requireScraperIdentity: RequestHandler = async (req, _res, next) => {
  try {
    const token = req.get(scraperIdentityHeader);
    if (!token || token.length > 4096) throw new Error('Missing identity');
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], issuer: 'relay-portal', audience: 'relay-scraper', maxTokenAge: '30s', requiredClaims: ['sub', 'exp'] });
    if (!payload.sub || payload.purpose !== 'scraper-management') throw new Error('Invalid identity');
    (req as ScraperRequest).scraperUserId = payload.sub;
    next();
  } catch { next(new HttpError(401, 'Sign in through the Relay console to manage scrapers.')); }
};
