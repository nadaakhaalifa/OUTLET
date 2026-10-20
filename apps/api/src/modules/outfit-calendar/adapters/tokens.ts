export const CALENDAR_STORE = Symbol("outfitCalendar.CalendarStore");
export const CALENDAR_ETA = Symbol("outfitCalendar.DeliveryEtaPort");
export const CALENDAR_NOTIFIER = Symbol("outfitCalendar.ReminderNotifierPort");
export const CALENDAR_STYLIST_PORTS = Symbol("outfitCalendar.StylistPorts");
export const CALENDAR_EVENT_RESOLVER = Symbol("outfitCalendar.EventResolver");

export const CREATE_CALENDAR_EVENT = Symbol("outfitCalendar.CreateEvent");
export const UPDATE_CALENDAR_EVENT = Symbol("outfitCalendar.UpdateEvent");
export const DELETE_CALENDAR_EVENT = Symbol("outfitCalendar.DeleteEvent");
export const CLEAR_CALENDAR = Symbol("outfitCalendar.ClearCalendar");
export const LIST_CALENDAR_EVENTS = Symbol("outfitCalendar.ListEvents");
export const GET_CALENDAR_EVENT = Symbol("outfitCalendar.GetEvent");
export const GENERATE_EVENT_OUTFITS = Symbol("outfitCalendar.GenerateEventOutfits");
export const ADD_GAP_TO_BAG = Symbol("outfitCalendar.AddGapToBag");
export const PROCESS_CALENDAR_REMINDERS = Symbol("outfitCalendar.ProcessDueReminders");
