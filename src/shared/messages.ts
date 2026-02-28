export type PageTextResponse = {
  title: string;
  url: string;
  text: string;
  icons?: string[];
};

export type PageMetaResponse = {
  url: string;
  icons: string[];
};

export type ContentMessage = {
  type: "GET_PAGE_TEXT";
} | {
  type: "GET_PAGE_META";
};

export type BackgroundMessage = {
  type: "CLASSIFY_CURRENT_TAB";
} | {
  type: "CREATE_CATEGORY_AND_MOVE";
  payload: {
    url: string;
    categoryName: string;
  };
} | {
  type: "OPEN_EXTERNAL_TAB";
  payload: {
    url: string;
  };
};
