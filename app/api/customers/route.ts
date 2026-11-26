import {

   PutCommand,

   ScanCommand,

   UpdateCommand,

} from "@aws-sdk/lib-dynamodb";

import { NextResponse } from "next/server";

import { ddb } from "@/lib/dynamo";

// ============================================================

// PRODUCTION AUTHENTICATION

// Uncomment before deploying to production.

// ============================================================

import { getAppSession } from "@/lib/app-session";

const CUSTOMERS_TABLE = "p72-CUBE-CUSTOMERS";

// ============================================================

// CUSTOMER TYPE

// ============================================================

type CustomerItem = {

   CustomerID: string;

   CustomerName: string;

   NextGenNames: string[];

   UMMName: string;

   CustomerType: string;

   ReportType: string;

   RateClass: string;

   RCBLComment: string;

   Active: boolean;

   CreatedDate: string;

   InactiveDate: string;

};

// ============================================================

// HELPERS

// ============================================================

function stringValue(

   value: unknown,

): string {

   if (

      value === undefined ||

      value === null

   ) {

      return "";

   }

   return String(value).trim();

}

function normalizeNextGenNames(

   value: unknown,

): string[] {

   if (!Array.isArray(value)) {

      return [];

   }

   return Array.from(

      new Set(

         value

            .map((item) =>

               String(item).trim(),

            )

            .filter(Boolean),

      ),

   );

}

function normalizeCustomer(

   value: unknown,

): CustomerItem {

   const source =

      typeof value === "object" &&

      value !== null

         ? (value as Record<

               string,

               unknown

            >)

         : {};

   return {

      CustomerID:

         stringValue(

            source.CustomerID,

         ),

      CustomerName:

         stringValue(

            source.CustomerName,

         ),

      NextGenNames:

         normalizeNextGenNames(

            source.NextGenNames,

         ),

      UMMName:

         stringValue(

            source.UMMName,

         ),

      CustomerType:

         stringValue(

            source.CustomerType,

         ),

      ReportType:

         stringValue(

            source.ReportType,

         ),

      RateClass:

         stringValue(

            source.RateClass,

         ),

      RCBLComment:

         stringValue(

            source.RCBLComment,

         ),

      Active:

         source.Active !== false,

      CreatedDate:

         stringValue(

            source.CreatedDate,

         ),

      InactiveDate:

         stringValue(

            source.InactiveDate,

         ),

   };

}

// ============================================================

// NEXT CUSTOMER ID
// Scan existing IDs and choose the next CUST-###### value.
// Conditional writes in POST protect against concurrent collisions.

// ============================================================

async function getNextCustomerID(): Promise<string> {

   let lastEvaluatedKey:

      | Record<string, unknown>

      | undefined;

   let highestNumber = 0;

   do {

      const result = await ddb.send(

         new ScanCommand({

            TableName:

               CUSTOMERS_TABLE,

            ProjectionExpression:

               "CustomerID",

            ExclusiveStartKey:

               lastEvaluatedKey,

         }),

      );

      for (

         const item of result.Items ?? []

      ) {

         const customerID =

            stringValue(

               item.CustomerID,

            );

         const match =

            /^CUST-(\d{6})$/.exec(

               customerID,

            );

         if (!match) {

            continue;

         }

         const number =

            Number(match[1]);

         if (

            Number.isFinite(number) &&

            number > highestNumber

         ) {

            highestNumber = number;

         }

      }

      lastEvaluatedKey =

         result.LastEvaluatedKey;

   } while (lastEvaluatedKey);

   return `CUST-${String(

      highestNumber + 1,

   ).padStart(6, "0")}`;

}

// ============================================================

// VALIDATE NEW CUSTOMER

// ============================================================

function validateNewCustomer(

   customer: CustomerItem,

): string | null {

   if (!customer.CustomerName) {

      return "Customer Name is required.";

   }

   return null;

}

// ============================================================

// VALIDATE EXISTING CUSTOMER

// ============================================================

function validateCustomer(

   customer: CustomerItem,

): string | null {

   if (!customer.CustomerID) {

      return "Customer ID is required.";

   }

   if (!customer.CustomerName) {

      return "Customer Name is required.";

   }

   return null;

}

// ============================================================

// CREATE

//

// POST /api/customers

//

// CustomerID is generated automatically by CUBE using:

//

// CUST-000001

// CUST-000002

// CUST-000003

// ...

//

// The browser does not control CustomerID.

// ============================================================

export async function POST(

   request: Request,

) {

   try {

      // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading the request body or changing
    // customer records in DynamoDB.
    // ========================================================

    const session =
      await getAppSession();

    if (
      !session?.user
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Unauthorized",
        },
        {
          status: 401,
        },
      );
    }

    // ========================================================
    // AUTHENTICATED REQUEST
    // ========================================================

    const body =

         await request.json();

      const customer =

         normalizeCustomer(body);

      // ========================================================

      // VALIDATE CREATE REQUEST

      // ========================================================

      // CustomerID is intentionally NOT

      // required here because CUBE

      // generates it.

      const validationError =

         validateNewCustomer(

            customer,

         );

      if (validationError) {

         return NextResponse.json(

            {

               error:

                  validationError,

            },

            {

               status: 400,

            },

         );

      }

      // ========================================================

      // CUBE-MANAGED VALUES

      // ========================================================

      // Ignore any CustomerID that may

      // have been supplied by the client.

      customer.CustomerID = "";

      // New customers always begin active.

      customer.Active = true;

      // CreatedDate is controlled by CUBE.

      customer.CreatedDate =

         new Date()

            .toISOString()

            .slice(0, 10);

      // Active customers do not have an

      // inactive date.

      customer.InactiveDate = "";

      // ========================================================

      // GENERATE CUSTOMER ID AND CREATE

      // ========================================================

      // Two simultaneous requests could

      // calculate the same next ID.

      //

      // DynamoDB's conditional Put prevents

      // one request from overwriting another.

      //

      // If a collision occurs, CUBE scans

      // again, generates the next available

      // ID, and retries.

      const MAX_ID_ATTEMPTS = 5;

      for (

         let attempt = 1;

         attempt <= MAX_ID_ATTEMPTS;

         attempt++

      ) {

         customer.CustomerID =

            await getNextCustomerID();

         try {

            await ddb.send(

               new PutCommand({

                  TableName:

                     CUSTOMERS_TABLE,

                  Item:

                     customer,

                  ConditionExpression:

                     "attribute_not_exists(CustomerID)",

               }),

            );

            return NextResponse.json(

               {

                  success: true,

                  customer,

               },

               {

                  status: 201,

               },

            );

         } catch (error) {

            const isIDCollision =

               error instanceof Error &&

               error.name ===

                  "ConditionalCheckFailedException";

            if (!isIDCollision) {

               throw error;

            }

            console.warn(

               `Customer ID collision on ${customer.CustomerID}. ` +

                  `Retrying (${attempt}/${MAX_ID_ATTEMPTS}).`,

            );

            if (

               attempt ===

               MAX_ID_ATTEMPTS

            ) {

               throw new Error(

                  "Unable to allocate a unique Customer ID.",

               );

            }

         }

      }

      // This should never be reached,

      // but provides a TypeScript-safe

      // fallback.

      throw new Error(

         "Unable to allocate a unique Customer ID.",

      );

   } catch (error) {

      console.error(

         "Create customer error:",

         error,

      );

      if (

         error instanceof Error &&

         error.message ===

            "Unable to allocate a unique Customer ID."

      ) {

         return NextResponse.json(

            {

               error:

                  "Unable to allocate a unique Customer ID.",

            },

            {

               status: 500,

            },

         );

      }

      return NextResponse.json(

         {

            error:

               "Unable to create customer.",

         },

         {

            status: 500,

         },

      );

   }

}

// ============================================================

// UPDATE CUSTOMER

//

// PUT /api/customers

//

// CustomerID is permanent.

// PUT can update an existing customer

// but cannot create a new customer.

// ============================================================

export async function PUT(

   request: Request,

) {

   try {

      // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading the request body or changing
    // customer records in DynamoDB.
    // ========================================================

    const session =
      await getAppSession();

    if (
      !session?.user
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Unauthorized",
        },
        {
          status: 401,
        },
      );
    }

    // ========================================================
    // AUTHENTICATED REQUEST
    // ========================================================

    const body =

         await request.json();

      const customer =

         normalizeCustomer(body);

      const validationError =

         validateCustomer(customer);

      if (validationError) {

         return NextResponse.json(

            {

               error:

                  validationError,

            },

            {

               status: 400,

            },

         );

      }

      await ddb.send(

         new PutCommand({

            TableName:

               CUSTOMERS_TABLE,

            Item:

               customer,

            // PUT may update an existing

            // customer but may not create one.

            ConditionExpression:

               "attribute_exists(CustomerID)",

         }),

      );

      return NextResponse.json({

         success: true,

         customer,

      });

   } catch (error) {

      console.error(

         "Update customer error:",

         error,

      );

      if (

         error instanceof Error &&

         error.name ===

            "ConditionalCheckFailedException"

      ) {

         return NextResponse.json(

            {

               error:

                  "The customer no longer exists.",

            },

            {

               status: 404,

            },

         );

      }

      return NextResponse.json(

         {

            error:

               "Unable to update customer.",

         },

         {

            status: 500,

         },

      );

   }

}

// ============================================================

// ACTIVATE / DEACTIVATE CUSTOMER
// PATCH changes status without replacing the full customer record.

//

// PATCH /api/customers

//

// Body:

//

// {

//    "CustomerID": "CUST-000042",

//    "Active": false

// }

// ============================================================

export async function PATCH(

   request: Request,

) {

   try {

      // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading the request body or changing
    // customer records in DynamoDB.
    // ========================================================

    const session =
      await getAppSession();

    if (
      !session?.user
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Unauthorized",
        },
        {
          status: 401,
        },
      );
    }

    // ========================================================
    // AUTHENTICATED REQUEST
    // ========================================================

    const body =

         (await request.json()) as Record<

            string,

            unknown

         >;

      const CustomerID =

         stringValue(

            body.CustomerID,

         );

      const Active =

         body.Active;

      if (!CustomerID) {

         return NextResponse.json(

            {

               error:

                  "Customer ID is required.",

            },

            {

               status: 400,

            },

         );

      }

      if (

         typeof Active !== "boolean"

      ) {

         return NextResponse.json(

            {

               error:

                  "Active must be true or false.",

            },

            {

               status: 400,

            },

         );

      }

      // ========================================================

      // ACTIVATE CUSTOMER

      // ========================================================

      if (Active) {

         await ddb.send(

            new UpdateCommand({

               TableName:

                  CUSTOMERS_TABLE,

               Key: {

                  CustomerID,

               },

               UpdateExpression:

                  "SET Active = :active REMOVE InactiveDate",

               ExpressionAttributeValues: {

                  ":active": true,

               },

               ConditionExpression:

                  "attribute_exists(CustomerID)",

               ReturnValues:

                  "ALL_NEW",

            }),

         );

         return NextResponse.json({

            success: true,

            CustomerID,

            Active: true,

            InactiveDate: "",

         });

      }

      // ========================================================

      // DEACTIVATE CUSTOMER

      // ========================================================

      const InactiveDate =

         new Date()

            .toISOString()

            .slice(0, 10);

      await ddb.send(

         new UpdateCommand({

            TableName:

               CUSTOMERS_TABLE,

            Key: {

               CustomerID,

            },

            UpdateExpression:

               "SET Active = :active, InactiveDate = :inactiveDate",

            ExpressionAttributeValues: {

               ":active": false,

               ":inactiveDate":

                  InactiveDate,

            },

            ConditionExpression:

               "attribute_exists(CustomerID)",

            ReturnValues:

               "ALL_NEW",

         }),

      );

      return NextResponse.json({

         success: true,

         CustomerID,

         Active: false,

         InactiveDate,

      });

   } catch (error) {

      console.error(

         "Customer status error:",

         error,

      );

      if (

         error instanceof Error &&

         error.name ===

            "ConditionalCheckFailedException"

      ) {

         return NextResponse.json(

            {

               error:

                  "The customer does not exist.",

            },

            {

               status: 404,

            },

         );

      }

      return NextResponse.json(

         {

            error:

               "Unable to update customer status.",

         },

         {

            status: 500,

         },

      );

   }

}
