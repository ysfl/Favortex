export type PageTextResponse = {
  title: string;
  url: string;
  text: string;
};

export type ContentMessage = {
  type: "GET_PAGE_TEXT";
};

export type BackgroundMessage = {
  type: "CLASSIFY_CURRENT_TAB";
};
