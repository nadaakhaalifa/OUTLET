import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "./config/env";
import { AuthModule } from "./modules/auth";
import { PrivacyModule } from "./modules/privacy";
import { PlatformModule, type PlatformOverrides } from "./platform";

@Module({})
export class AppModule {
  static register(config: AppConfig, overrides: PlatformOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config, overrides), AuthModule.forRoot(config), PrivacyModule.forRoot(config)],
    };
  }
}
