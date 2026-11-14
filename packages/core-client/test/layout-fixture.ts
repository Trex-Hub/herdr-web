/** A `herdr-app` document shaped like the real one (ids and names made up). */
export const realShaped = {
  spaces: [
    {
      id: "spa1b2c3d4e5f60718293a4b5c6d7e8f9",
      name: "zosmaai",
      folder: "/Users/x/work/zosmaai",
      color: "blue", // a field a newer app may add to a space: ignored here
      tabs: [
        {
          id: "tb00000000000000000000000000000001",
          name: "ayra",
          root: {
            id: "tb00000000000000000000000000000001",
            type: "row",
            children: [{ id: "p1", type: "block", size: { weight: 1 }, content: { terminal: "t9" } }],
          },
        },
        {
          id: "tb00000000000000000000000000000002",
          name: "",
          root: {
            id: "tb00000000000000000000000000000002",
            type: "row",
            children: [
              { id: "p2", type: "block", size: { weight: 1 }, content: { terminal: "t10" } },
              {
                id: "s1",
                type: "column",
                size: { weight: 1 },
                children: [
                  { id: "p3", type: "block", size: { weight: 2 }, content: { terminal: "t12" } },
                  { id: "p4", type: "block", size: { weight: 1 }, content: { mod: "chat", props: { agent: "t12" } } },
                ],
              },
            ],
          },
        },
      ],
    },
    {
      id: "sp0000000000000000000000000000000b",
      name: "devendra",
      folder: "/Users/x",
      tabs: [{ id: "tb00000000000000000000000000000003", name: "setup", root: { id: "tb00000000000000000000000000000003", type: "row", children: [] } }],
    },
  ],
};
