import { MongoClient, type Db } from "mongodb";

export class MongoNotConfigured extends Error {
  constructor() {
    super("MONGODB_URI is not set");
    this.name = "MongoNotConfigured";
  }
}

const globalForMongo = globalThis as unknown as {
  _mongoReady?: Promise<Db>;
};

export function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return Promise.reject(new MongoNotConfigured());

  if (!globalForMongo._mongoReady) {
    const client = new MongoClient(uri);
    globalForMongo._mongoReady = client
      .connect()
      .then(async (connected) => {
        const db = connected.db(process.env.MONGODB_DB || "cloudscan");
        await db.collection("buildings").createIndex({ id: 1 }, { unique: true });
        await db.collection("buildings").createIndex({ location: "2dsphere" });
        await db.collection("explorations").createIndex({ buildingId: 1, endedAt: -1 });
        return db;
      })
      .catch((error: unknown) => {
        globalForMongo._mongoReady = undefined;
        throw error;
      });
  }

  return globalForMongo._mongoReady;
}

export function databaseError(error: unknown): Response {
  if (error instanceof MongoNotConfigured) {
    return Response.json({ error: "MONGODB_URI is not set" }, { status: 503 });
  }
  console.error(error);
  return Response.json({ error: "Database error" }, { status: 500 });
}
