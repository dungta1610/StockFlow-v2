import { Module } from '@nestjs/common';
import { SchedulerRunner } from './scheduler.runner';

@Module({
  providers: [SchedulerRunner],
  exports: [SchedulerRunner],
})
export class SchedulerModule {}
