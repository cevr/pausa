Inspired by [Brian's](https://twitter.com/brian_d_vaughn) work in [Suspense](https://github.com/bvaughn/suspense)

**Pausa** is a simple and powerful React library designed to optimize your application's performance with effortless caching mechanisms built on top of React's Suspense.

Pausa makes it easier to manage and reuse data across your components, improving efficiency and reducing redundant network requests.

## 🚀 Features

- **Efficient Caching**: Automatically cache resolved data, reducing the need for repetitive requests.
- **Flexible TTL**: Customize Time-to-Live (TTL) for cached data to match your application's needs.
- **Automatic Invalidation**: Supports fine-grained cache invalidation to keep your data fresh.
- **Resource Management**: Manage multiple resources with ease using our intuitive API.
- **Optimistic Updates**: Seamlessly update your UI with optimistic data handling.

## 📦 Installation

To start using Pausa in your React project, install it via npm or yarn:

```bash
npm install pausa
```

or

```bash
yarn add pausa
```

## 🛠️ Usage

Pausa integrates directly into your React components, allowing you to cache data and manage Suspense boundaries with ease. Here's a quick example:

```javascript
import React, { Suspense } from "react";
import { cache } from "pausa";

const dataCache = cache(async (context, key) => {
  const response = await fetch(`/api/data/\${key}`);
  return response.json();
});

function MyComponent({ dataKey }) {
  const data = dataCache.use(dataKey);
  return <div>{data.name}</div>;
}

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <MyComponent dataKey="123" />
    </Suspense>
  );
}
```

## 📚 API Reference

- **`cache(loadFunction, options)`**: Creates a new cache with the provided load function and options.
- **`cache.use(key)`**: Retrieves the cached data for the specified key, suspending if not yet resolved.
- **`cache.invalidate(key)`**: Invalidates the cached data for the specified key.
- **`cache.set(key, value)`**: Manually sets the cached value for a specific key.

For detailed API documentation, refer to the [full documentation](#).

## 🤝 Contributing

We welcome contributions! To get started:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature/my-feature`).
3. Make your changes and commit (`git commit -m 'Add new feature'`).
4. Push to the branch (`git push origin feature/my-feature`).
5. Open a pull request.

Please make sure to update tests as appropriate.

## 📄 License

Pausa is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.
