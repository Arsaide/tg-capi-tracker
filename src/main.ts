import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import {NestExpressApplication} from "@nestjs/platform-express";

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule)

    app.set('trust proxy', 1)
    app.use(json());

    app.enableCors({ origin: true });

    app.getHttpAdapter().getInstance().set('trust proxy', true);

    const port = process.env.PORT || 3000;
    await app.listen(port);
    console.log(`HTTP listening on :${port}`);
}
void bootstrap();
