/** Single seam to the pure forecasting domain (@outlet/domain namespace `forecasting`). Aliases only; no behaviour. */
import { forecasting } from "@outlet/domain";

export type DemandDayInput = forecasting.DemandDayInput;
export type DemandInterval = forecasting.DemandInterval;
export type ForecastOutcome = forecasting.ForecastOutcome;
export type ForecastOk = forecasting.ForecastOk;
export type HorizonDays = forecasting.HorizonDays;
export type ModelId = forecasting.ModelId;
export type ReasonCode = forecasting.ReasonCode;
export type InsufficientReason = forecasting.InsufficientReason;
export import HORIZONS = forecasting.HORIZONS;
export import MODEL_VERSION = forecasting.MODEL_VERSION;
export import NOMINAL_COVERAGE_BPS = forecasting.NOMINAL_COVERAGE_BPS;
export import FORECAST_K_MIN = forecasting.FORECAST_K_MIN;
export import forecastSeries = forecasting.forecastSeries;
export import prepareSeries = forecasting.prepareSeries;
export import reconcileTopDown = forecasting.reconcileTopDown;
export import shopperSupportLowerBound = forecasting.shopperSupportLowerBound;
export import geographyCellReleasable = forecasting.geographyCellReleasable;
export import isoDayToIndex = forecasting.isoDayToIndex;
export import indexToIsoDay = forecasting.indexToIsoDay;
