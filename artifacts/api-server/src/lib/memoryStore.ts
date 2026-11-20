import bcrypt from "bcryptjs";

export interface MemoryUser {
  id: number;
  username: string;
  email: string | null;
  ownerId: number | null;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryPasswordResetCode {
  id: number;
  userId: number;
  email: string;
  codeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface MemorySettings {
  id: number;
  businessName: string;
  logoUrl: string | null;
  updatedAt: Date;
}

export interface MemoryProduct {
  id: number;
  ownerId: number;
  name: string;
  sku: string | null;
  description: string | null;
  priceCents: number;
  stock: number;
  category: string | null;
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryOrder {
  id: number;
  ownerId: number;
  reference: string;
  status: string;
  totalCents: number;
  customerPhone: string | null;
  customerName: string | null;
  cashierName: string | null;
  paymentMethod: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryOrderItem {
  id: number;
  orderId: number;
  productId: number;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface MemoryTransaction {
  id: number;
  ownerId: number;
  orderId: number | null;
  amountCents: number;
  provider: string;
  status: string;
  mpesaCheckoutRequestId: string | null;
  mpesaMerchantRequestId: string | null;
  mpesaReceiptNumber: string | null;
  phoneNumber: string | null;
  rawCallback: string | null;
  createdAt: Date;
}

export interface MemoryUploadedFile {
  buffer: Buffer;
  contentType: string;
}

class MemoryStore {
  users: MemoryUser[] = [];
  settingsByOwner = new Map<number, MemorySettings>();
  products: MemoryProduct[] = [];
  orders: MemoryOrder[] = [];
  orderItems: MemoryOrderItem[] = [];
  transactions: MemoryTransaction[] = [];
  passwordResetCodes: MemoryPasswordResetCode[] = [];
  uploadedFiles = new Map<string, MemoryUploadedFile>();

  private nextUserId = 1;
  private nextProductId = 1;
  private nextOrderId = 1;
  private nextOrderItemId = 1;
  private nextTransactionId = 1;
  private nextResetCodeId = 1;
  private seeded = false;

  getOrCreateSettings(ownerId: number): MemorySettings {
    this.ensureSeeded();
    let existing = this.settingsByOwner.get(ownerId);
    if (!existing) {
      existing = {
        id: ownerId,
        businessName: "SmartBuy",
        logoUrl: null,
        updatedAt: new Date(),
      };
      this.settingsByOwner.set(ownerId, existing);
    }
    return existing;
  }

  ensureSeeded() {
    if (this.seeded) return;
    this.seeded = true;

    const now = new Date();
    if (this.users.length === 0) {
      this.users.push({
        id: this.nextUserId++,
        username: "admin",
        email: "admin@smartbuy.co.ke",
        ownerId: null,
        passwordHash: bcrypt.hashSync("admin", 10),
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!this.settingsByOwner.has(1)) {
      this.settingsByOwner.set(1, {
        id: 1,
        businessName: "SmartBuy",
        logoUrl: null,
        updatedAt: now,
      });
    }

    if (this.products.length === 0) {
      const defaults: Array<
        Omit<MemoryProduct, "id" | "ownerId" | "createdAt" | "updatedAt">
      > = [
        {
          name: "Maize Flour (Unga) 2kg",
          sku: "SB-001",
          description: "Fortified white sifted maize meal",
          priceCents: 21000,
          stock: 25,
          category: "Groceries",
          imageUrl: "/images/product-unga.png",
        },
        {
          name: "Fresh Milk 500ml",
          sku: "SB-002",
          description: "Pasteurized whole milk pouch",
          priceCents: 6500,
          stock: 40,
          category: "Dairy",
          imageUrl: "/images/product-milk.png",
        },
        {
          name: "White Bread 400g",
          sku: "SB-003",
          description: "Soft sliced sandwich loaf",
          priceCents: 6500,
          stock: 18,
          category: "Bakery",
          imageUrl: "/images/product-bread.png",
        },
        {
          name: "Cooking Oil 1L",
          sku: "SB-004",
          description: "Pure vegetable cooking oil",
          priceCents: 34000,
          stock: 14,
          category: "Groceries",
          imageUrl: "/images/product-oil.png",
        },
        {
          name: "Kenyan Tea Leaves 250g",
          sku: "SB-005",
          description: "Rich highland black tea leaves",
          priceCents: 18500,
          stock: 20,
          category: "Beverages",
          imageUrl: "/images/product-tea.png",
        },
        {
          name: "Laundry Bar Soap 800g",
          sku: "SB-006",
          description: "Multipurpose washing bar soap",
          priceCents: 19500,
          stock: 3,
          category: "Household",
          imageUrl: "/images/product-soap.png",
        },
      ];

      for (const p of defaults) {
        this.products.push({
          id: this.nextProductId++,
          ownerId: 1,
          ...p,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  allocUserId() {
    return this.nextUserId++;
  }
  allocProductId() {
    return this.nextProductId++;
  }
  allocOrderId() {
    return this.nextOrderId++;
  }
  allocOrderItemId() {
    return this.nextOrderItemId++;
  }
  allocTransactionId() {
    return this.nextTransactionId++;
  }
  allocResetCodeId() {
    return this.nextResetCodeId++;
  }
}

export const memoryStore = new MemoryStore();
